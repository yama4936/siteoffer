import {
  ACTIVE_ASSIGNMENT_STATUSES,
  assignments,
  companies,
  contracts,
  type DbOrTx,
  productTerms,
  proposals,
  proposalVersions,
  salesOfferChanges,
  salesOffers,
  shareLinks,
  users,
} from "@siteoffer/db";
import {
  offerChangeDecisionSchema as decisionInput,
  offerChangeProposalSchema as proposalInput,
  offerChangeIdSchema as uuid,
} from "@siteoffer/schemas";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { lockAssignmentCompany } from "../assignment/shared.ts";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok } from "../common/result.ts";
import { findSecretInFields } from "../domain-preference/secrets.ts";
import { isTermsReadyForSales } from "../reward/rule.ts";
import { getSalesOffer, nextSalesOfferVersion } from "./offer.ts";

function human(actor: Actor | null): actor is Extract<Actor, { kind: "ops" | "sales" }> {
  return !!actor && (actor.kind === "ops" || actor.kind === "sales") && uuid.safeParse(actor.userId).success;
}
async function activeUser(db: DbOrTx, actor: Extract<Actor, { kind: "ops" | "sales" }>, lock = false) {
  const q = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, actor.kind), eq(users.status, "active")));
  return (lock ? await q.for("share") : await q)[0];
}
async function openContract(db: DbOrTx, assignmentId: string) {
  return (
    await db
      .select({ id: contracts.id })
      .from(contracts)
      .where(
        and(
          eq(contracts.assignmentId, assignmentId),
          inArray(contracts.status, ["reported", "under_review", "completed"]),
        ),
      )
      .limit(1)
  )[0];
}
const active = (status: string) => (ACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(status);

/** Assignment lock serializes changes with reporting/reassignment; company lock allocates offer versions. */
export async function proposeSalesOfferChange(db: DbOrTx, clock: Clock, actor: Actor | null, input: unknown) {
  if (!human(actor) || actor.kind !== "ops") return err("forbidden", "運営だけが条件変更を提案できます。");
  const p = proposalInput.safeParse(input);
  if (!p.success) return err("invalid_input", "対象・変更する条件・理由を確認してください。");
  const i = p.data;
  if (findSecretInFields({ reason: i.reason })) return err("secret_like_value", "理由に秘密情報を含めないでください。");
  return db.transaction(async (tx) => {
    if (!(await activeUser(tx, actor, true))) return err("forbidden", "有効な運営アカウントで操作してください。");
    const [initial] = await tx
      .select({ companyId: assignments.companyId })
      .from(assignments)
      .where(eq(assignments.id, i.assignmentId));
    if (!initial) return err("not_found", "担当案件が見つかりません。");
    // Proposal -> company -> assignment, shared with proposal review and suppression.
    await tx
      .select({ id: proposals.id })
      .from(proposals)
      .where(eq(proposals.companyId, initial.companyId))
      .for("share");
    const companyId = await lockAssignmentCompany(tx, i.assignmentId);
    const [a] = await tx
      .select()
      .from(assignments)
      .where(and(eq(assignments.id, i.assignmentId), eq(assignments.companyId, companyId ?? initial.companyId)))
      .for("update");
    if (!a || !companyId) return err("not_found", "担当案件が見つかりません。");
    const [receipt] = await tx.select().from(salesOfferChanges).where(eq(salesOfferChanges.id, i.requestId));
    if (receipt) {
      const offer = await getSalesOffer(tx, a.companyId, receipt.toOfferId);
      return receipt.assignmentId === a.id &&
        receipt.requestedBy === actor.userId &&
        receipt.fromOfferId === i.expectedOfferId &&
        receipt.reason === i.reason &&
        offer?.terms.id === i.productTermsId &&
        offer?.proposal.id === i.proposalVersionId
        ? ok(receipt)
        : err("operation_conflict", "この受付番号は別の内容で使用済みです。画面を開き直してください。");
    }
    if (!active(a.status) || (await openContract(tx, a.id)))
      return err(
        "contract_in_progress",
        "契約確認中・完了の案件は変更できません。報告済みの場合は、先に理由を添えて差し戻してください。",
      );
    if (a.salesOfferId !== i.expectedOfferId)
      return err("offer_changed", "現在の販売条件が変わっています。画面を開き直してください。");
    const [pending] = await tx
      .select({ id: salesOfferChanges.id })
      .from(salesOfferChanges)
      .where(and(eq(salesOfferChanges.assignmentId, a.id), eq(salesOfferChanges.status, "pending")));
    if (pending) return err("change_pending", "営業の確認待ちの変更があります。回答を待つか取り下げてください。");
    const [company] = await tx.select().from(companies).where(eq(companies.id, a.companyId));
    if (company?.suppression !== "none") return err("company_suppressed", "営業抑止中の企業の条件は変更できません。");
    const [terms] = await tx.select().from(productTerms).where(eq(productTerms.id, i.productTermsId)).for("share");
    const [proposal] = await tx
      .select({ id: proposalVersions.id })
      .from(proposalVersions)
      .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
      .where(
        and(
          eq(proposalVersions.id, i.proposalVersionId),
          eq(proposals.companyId, a.companyId),
          eq(proposalVersions.status, "approved"),
        ),
      );
    if (!terms || !isTermsReadyForSales(terms) || !proposal)
      return err("not_ready", "有効な販売条件と、この企業の承認済み提案を選んでください。");
    const before = await getSalesOffer(tx, a.companyId, a.salesOfferId);
    if (!before) return err("not_ready", "現在の引き継ぎ条件を確認できません。");
    if (before.terms.id === terms.id && before.proposal.id === proposal.id)
      return err("unchanged", "現在と同じ条件です。変更する項目を選んでください。");
    const now = clock.now();
    const [offer] = await tx
      .insert(salesOffers)
      .values({
        companyId: a.companyId,
        version: await nextSalesOfferVersion(tx, a.companyId),
        isPublic: false,
        productTermsId: terms.id,
        proposalVersionId: proposal.id,
        createdBy: actor.userId,
        createdAt: now,
      })
      .returning();
    const [change] = await tx
      .insert(salesOfferChanges)
      .values({
        id: i.requestId,
        assignmentId: a.id,
        salesUserId: a.userId,
        fromOfferId: before.offer.id,
        toOfferId: offer!.id,
        requestedBy: actor.userId,
        reason: i.reason,
        createdAt: now,
      })
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "sales_offer.change_proposed",
      targetType: "assignment",
      targetId: a.id,
      after: change,
    });
    return ok(change!);
  });
}

export async function decideSalesOfferChange(db: DbOrTx, clock: Clock, actor: Actor | null, input: unknown) {
  if (!human(actor)) return err("forbidden", "ログインして操作してください。");
  const p = decisionInput.safeParse(input);
  if (!p.success) return err("invalid_input", "変更の回答を確認してください。");
  const i = p.data;
  if ((i.decision === "cancel") !== (actor.kind === "ops")) return err("forbidden", "この回答を行う権限がありません。");
  if (i.decision === "accept" && !i.confirmed)
    return err("confirmation_required", "変更内容を確認してチェックを入れてください。");
  if (i.decision !== "accept" && !i.note) return err("reason_required", "理由を入力してください。");
  if (findSecretInFields({ note: i.note })) return err("secret_like_value", "理由に秘密情報を含めないでください。");
  return db.transaction(async (tx) => {
    const [initial] = await tx.select().from(salesOfferChanges).where(eq(salesOfferChanges.id, i.changeId));
    if (!initial) return err("not_found", "変更提案が見つかりません。");
    if (!(await activeUser(tx, actor, true))) return err("forbidden", "この担当案件の変更は操作できません。");
    const [candidate] = await tx
      .select({ companyId: assignments.companyId })
      .from(assignments)
      .where(eq(assignments.id, initial.assignmentId));
    if (!candidate) return err("forbidden", "この担当案件の変更は操作できません。");
    await tx
      .select({ id: proposals.id })
      .from(proposals)
      .where(eq(proposals.companyId, candidate.companyId))
      .for("share");
    const companyId = await lockAssignmentCompany(tx, initial.assignmentId);
    const [a] = await tx
      .select()
      .from(assignments)
      .where(and(eq(assignments.id, initial.assignmentId), eq(assignments.companyId, companyId ?? candidate.companyId)))
      .for("update");
    if (
      !a ||
      !companyId ||
      (actor.kind === "sales" && (a.userId !== actor.userId || initial.salesUserId !== actor.userId))
    )
      return err("forbidden", "この担当案件の変更は操作できません。");
    const [change] = await tx
      .select()
      .from(salesOfferChanges)
      .where(eq(salesOfferChanges.id, i.changeId))
      .for("update");
    const status = i.decision === "accept" ? "accepted" : i.decision === "decline" ? "declined" : "cancelled";
    if (change!.status !== "pending")
      return change!.status === status && change!.decidedBy === actor.userId
        ? ok(change!)
        : err("already_decided", "この変更はすでに回答済みです。現在の状態を確認してください。");
    if (i.decision !== "cancel") {
      if (!active(a.status) || a.salesOfferId !== change!.fromOfferId)
        return err("assignment_changed", "担当または現在の条件が変わったため、この変更は適用できません。");
      if (await openContract(tx, a.id))
        return err("contract_in_progress", "契約の確認が進んでいます。運営に相談してください。");
    }
    if (i.decision === "accept") {
      const after = await getSalesOffer(tx, a.companyId, change!.toOfferId);
      if (!after || after.offer.isPublic) return err("not_ready", "変更する条件を確認できません。");
      await tx
        .select({ id: proposals.id })
        .from(proposals)
        .where(eq(proposals.id, after.proposal.proposalId))
        .for("share");
      const [company] = await tx.select().from(companies).where(eq(companies.id, a.companyId));
      const [terms] = await tx.select().from(productTerms).where(eq(productTerms.id, after.terms.id)).for("share");
      const [pv] = await tx
        .select()
        .from(proposalVersions)
        .where(eq(proposalVersions.id, after.proposal.id))
        .for("share");
      if (company?.suppression !== "none" || !terms || !isTermsReadyForSales(terms) || pv?.status !== "approved")
        return err("not_ready", "提案または販売条件が変更されています。運営に内容の再確認を依頼してください。");
      await tx
        .update(assignments)
        .set({ salesOfferId: after.offer.id, lastActivityAt: clock.now() })
        .where(eq(assignments.id, a.id));
      const revoked = await tx
        .update(shareLinks)
        .set({ revokedAt: clock.now() })
        .where(
          and(
            eq(shareLinks.companyId, a.companyId),
            eq(shareLinks.createdBy, a.userId),
            eq(shareLinks.purpose, "proposal"),
            isNull(shareLinks.revokedAt),
          ),
        )
        .returning({ id: shareLinks.id });
      for (const link of revoked)
        await recordEvent(tx, clock, {
          actor,
          action: "share_link.revoke",
          targetType: "share_link",
          targetId: link.id,
          after: { reason: "sales_offer_changed", changeId: change!.id },
        });
    }
    const [decided] = await tx
      .update(salesOfferChanges)
      .set({ status, responseNote: i.note || null, decidedBy: actor.userId, decidedAt: clock.now() })
      .where(eq(salesOfferChanges.id, i.changeId))
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: `sales_offer.change_${status}`,
      targetType: "assignment",
      targetId: a.id,
      before: { salesOfferId: a.salesOfferId },
      after: decided,
    });
    return ok(decided!);
  });
}

export async function getOfferChangeContext(db: DbOrTx, actor: Actor | null, assignmentId: string) {
  if (!human(actor) || !uuid.safeParse(assignmentId).success || !(await activeUser(db, actor))) return err("forbidden");
  const [a] = await db.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!a || (actor.kind === "sales" && a.userId !== actor.userId)) return err("not_found");
  const [company] = await db
    .select({ id: companies.id, name: companies.name, suppression: companies.suppression })
    .from(companies)
    .where(eq(companies.id, a.companyId));
  const current = a.salesOfferId ? await getSalesOffer(db, a.companyId, a.salesOfferId) : null;
  const rows = await db
    .select()
    .from(salesOfferChanges)
    .where(eq(salesOfferChanges.assignmentId, a.id))
    .orderBy(desc(salesOfferChanges.createdAt), desc(salesOfferChanges.id))
    .limit(20);
  const history = await Promise.all(
    rows.map(async (change) => ({
      change,
      before: await getSalesOffer(db, a.companyId, change.fromOfferId),
      after: await getSalesOffer(db, a.companyId, change.toOfferId),
    })),
  );
  const blocked = !active(a.status)
    ? "担当が終了しているため変更できません。"
    : (await openContract(db, a.id))
      ? "契約確認中・完了のため変更できません。条件を修正する場合は運営が成約報告を差し戻してください。"
      : !current
        ? "引き継ぎ条件を確認できません。運営が営業への引き継ぎを確認してください。"
        : company?.suppression !== "none"
          ? "営業抑止中のため条件を変更できません。"
          : null;
  const terms =
    actor.kind === "ops"
      ? (
          await db
            .select()
            .from(productTerms)
            .where(eq(productTerms.active, true))
            .orderBy(desc(productTerms.createdAt))
        ).filter(isTermsReadyForSales)
      : [];
  const versions =
    actor.kind === "ops"
      ? await db
          .select({ id: proposalVersions.id, version: proposalVersions.version })
          .from(proposalVersions)
          .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
          .where(and(eq(proposals.companyId, a.companyId), eq(proposalVersions.status, "approved")))
          .orderBy(desc(proposalVersions.version))
      : [];
  return ok({ assignment: a, company: company!, current, history, blocked, terms, versions });
}
