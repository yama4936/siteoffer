import {
  assignments,
  contracts,
  type DbOrTx,
  productTerms,
  proposals,
  proposalVersions,
  rewards,
  users,
} from "@siteoffer/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok, type Result } from "../common/result.ts";
import { findDomainPreferenceForContract } from "../domain-preference/domain-preference.ts";
import { findSecretInFields } from "../domain-preference/secrets.ts";
import { authorizeUser } from "../permissions/policy.ts";
import type { Reward } from "../reward/reward.ts";
import { calculateRewardAmount, parseRewardRule, type RewardRule, termsReadinessIssues } from "../reward/rule.ts";

export type Contract = typeof contracts.$inferSelect;

/**
 * 契約完了時に固定する写し（14章）。product_terms 等を後で変えても、この内容は変わらない。
 * 構造を変えるときは version を上げ、読む側で古い版も扱う。
 */
export interface ContractSnapshot {
  version: 1;
  /** 販売条件 */
  terms: {
    id: string;
    version: string;
    name: string;
    price: number;
    scope: unknown;
    monthlyFee: number | null;
  };
  /** 報酬条件と、この契約で発生させた報酬額 */
  reward: { rule: RewardRule; amount: number };
  proposalVersion: { id: string; proposalId: string; version: number } | null;
  /** ドメイン対応（聞き取り内容の写し）。未記録なら null */
  domain: {
    preferenceId: string;
    intent: string;
    currentUrl: string | null;
    currentDomain: string | null;
    newDomainCandidates: string[];
    currentManager: string;
    usesEmail: string;
    customerWish: string | null;
    needsOpsReview: boolean;
    confirmedAt: string | null;
  } | null;
  sales: { userId: string; displayName: string; assignmentId: string };
  documentRef: string;
  confirmedBy: string;
  completedAt: string;
}

export type ContractError =
  | "forbidden"
  | "not_found"
  | "assignment_not_found"
  | "invalid_state"
  | "already_reported"
  | "secret_like_value"
  | "terms_not_found"
  | "terms_not_ready"
  | "document_required"
  | "proposal_version_mismatch";

const REPORTABLE_ASSIGNMENT_STATUSES = ["claimed", "working", "negotiating", "awaiting_ops"] as const;
const OPEN_CONTRACT_STATUSES = ["reported", "under_review"] as const;

function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    if ((cur as { code?: unknown }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 成約報告（営業）。担当の営業本人だけが行える。報告だけでは報酬は発生しない。
 * 担当の状態を contract_pending（契約確認待ち）にする。
 * TODO(統合)：担当の状態遷移はT2の関数に寄せる。現状はここで assignments を直接更新している。
 */
export async function reportContract(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: {
    assignmentId: string;
    productTermsId?: string | null;
    proposalVersionId?: string | null;
    documentRef?: string | null;
    reportNote?: string | null;
  },
): Promise<Result<Contract, ContractError>> {
  // 業務条件：成約報告は担当の営業本人が行う（運営は can() では report を許されるが、報告の主体にしない）
  if (actor.kind !== "sales") return err("forbidden");
  const secret = findSecretInFields({ reportNote: input.reportNote, documentRef: input.documentRef });
  if (secret) return err("secret_like_value", `${secret.field} に秘密らしき値が含まれているため保存しませんでした`);

  try {
    return await db.transaction(async (tx) => {
      const [a] = await tx.select().from(assignments).where(eq(assignments.id, input.assignmentId)).for("update");
      if (!a) return err("assignment_not_found");
      // 権限：契約の report。所有者は読んだ担当の営業ユーザー
      const auth = authorizeUser(actor, "report", { type: "contract", ownerUserId: a.userId });
      if (!auth.ok) return auth;
      if (a.status === "contract_pending") return err("already_reported");
      if (!(REPORTABLE_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status)) return err("invalid_state");

      const now = clock.now();
      const [contract] = await tx
        .insert(contracts)
        .values({
          companyId: a.companyId,
          assignmentId: a.id,
          salesUserId: actor.userId,
          status: "reported",
          productTermsId: input.productTermsId ?? null,
          proposalVersionId: input.proposalVersionId ?? null,
          documentRef: input.documentRef?.trim() || null,
          reportNote: input.reportNote?.trim() || null,
          reportedAt: now,
          createdAt: now,
        })
        .returning();
      const [assignmentAfter] = await tx
        .update(assignments)
        .set({ status: "contract_pending", lastActivityAt: now })
        .where(eq(assignments.id, a.id))
        .returning();

      await recordEvent(tx, clock, {
        actor,
        action: "contract.report",
        targetType: "contract",
        targetId: contract!.id,
        after: contract,
      });
      await recordEvent(tx, clock, {
        actor,
        action: "assignment.status_change",
        targetType: "assignment",
        targetId: a.id,
        before: { status: a.status },
        after: { status: assignmentAfter!.status, reason: "contract_reported" },
      });
      return ok(contract!);
    });
  } catch (e) {
    // 同じ担当への報告が並行した場合、一意制約（contracts_one_open_per_assignment）で片方が失敗する
    if (isUniqueViolation(e)) return err("already_reported");
    throw e;
  }
}

/** 運営が契約資料の確認を始めた（reported → under_review）。任意の中間状態 */
export async function startContractReview(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: { contractId: string },
): Promise<Result<Contract, ContractError>> {
  // 対象を読む前に確かめる（所有者を限定しない確認。営業は常に拒否される）
  const auth = authorizeUser(actor, "confirm", { type: "contract", ownerUserId: null });
  if (!auth.ok) return auth;
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(contracts).where(eq(contracts.id, input.contractId)).for("update");
    if (!before) return err("not_found");
    if (before.status !== "reported") return err("invalid_state");
    const [after] = await tx
      .update(contracts)
      .set({ status: "under_review" })
      .where(eq(contracts.id, input.contractId))
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "contract.start_review",
      targetType: "contract",
      targetId: input.contractId,
      before: { status: before.status },
      after: { status: after!.status },
    });
    return ok(after!);
  });
}

export interface ConfirmContractResult {
  contract: Contract;
  reward: Reward;
  /** すでに完了済みだった（再実行）。報酬は新たに発生していない */
  alreadyCompleted: boolean;
}

/**
 * 契約確認（運営）。契約を completed にし、スナップショットを保存し、報酬を1件発生させる。
 *
 * 二重発生の防止：
 * 1. 契約行を SELECT ... FOR UPDATE で押さえ、完了済みなら既存の報酬を返す（冪等）。
 * 2. 状態の更新は「reported / under_review のときだけ」の条件付き UPDATE。
 * 3. rewards.contract_id の一意制約と ON CONFLICT DO NOTHING。
 * どれか1つが破られても、残りで報酬は1件に保たれる。
 *
 * 報酬は契約完了で発生させる（14章で確定）。顧客入金の確認は条件にしない。
 * TODO(統合)：担当の状態遷移（contract_pending → completed）はT2の関数に寄せる。
 */
export async function confirmContract(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: {
    contractId: string;
    productTermsId?: string;
    proposalVersionId?: string;
    documentRef?: string;
  },
): Promise<Result<ConfirmContractResult, ContractError>> {
  // 対象を読む前に確かめる（所有者を限定しない確認。営業は常に拒否される）
  const auth = authorizeUser(actor, "confirm", { type: "contract", ownerUserId: null });
  if (!auth.ok) return auth;
  if (input.documentRef) {
    const secret = findSecretInFields({ documentRef: input.documentRef });
    if (secret) return err("secret_like_value");
  }

  return db.transaction(async (tx) => {
    const [contract] = await tx.select().from(contracts).where(eq(contracts.id, input.contractId)).for("update");
    if (!contract) return err("not_found");

    if (contract.status === "completed") {
      const [existing] = await tx.select().from(rewards).where(eq(rewards.contractId, contract.id));
      // 完了済みなのに報酬がない状態は、この関数を通っていれば起こらない
      if (!existing) throw new Error(`completed contract ${contract.id} has no reward`);
      return ok({ contract, reward: existing, alreadyCompleted: true });
    }
    if (!(OPEN_CONTRACT_STATUSES as readonly string[]).includes(contract.status)) return err("invalid_state");

    const documentRef = input.documentRef?.trim() || contract.documentRef;
    if (!documentRef) return err("document_required", "契約資料を登録してから確認してください");

    const termsId = input.productTermsId ?? contract.productTermsId;
    if (!termsId) return err("terms_not_found");
    const [terms] = await tx.select().from(productTerms).where(eq(productTerms.id, termsId));
    if (!terms) return err("terms_not_found");
    const issues = termsReadinessIssues(terms);
    if (issues.length > 0) return err("terms_not_ready", issues.join(","));
    const rule = parseRewardRule(terms.rewardRule);
    if (!rule.ok) return err("terms_not_ready", rule.error);
    const amount = calculateRewardAmount(rule.value, terms.price);
    if (!amount.ok) return err("terms_not_ready", amount.error);

    const proposalVersionId = input.proposalVersionId ?? contract.proposalVersionId;
    let proposalVersion: ContractSnapshot["proposalVersion"] = null;
    if (proposalVersionId) {
      const [pv] = await tx
        .select({ id: proposalVersions.id, proposalId: proposalVersions.proposalId, version: proposalVersions.version })
        .from(proposalVersions)
        .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
        .where(and(eq(proposalVersions.id, proposalVersionId), eq(proposals.companyId, contract.companyId)));
      if (!pv) return err("proposal_version_mismatch");
      proposalVersion = pv;
    }

    const [salesUser] = await tx
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, contract.salesUserId));
    const domain = await findDomainPreferenceForContract(tx, contract.companyId, contract.assignmentId);

    const now = clock.now();
    const snapshot: ContractSnapshot = {
      version: 1,
      terms: {
        id: terms.id,
        version: terms.version,
        name: terms.name,
        price: terms.price!,
        scope: terms.scope,
        monthlyFee: terms.monthlyFee,
      },
      reward: { rule: rule.value, amount: amount.value },
      proposalVersion,
      domain: domain
        ? {
            preferenceId: domain.id,
            intent: domain.intent,
            currentUrl: domain.currentUrl,
            currentDomain: domain.currentDomain,
            newDomainCandidates: [...domain.newDomainCandidates],
            currentManager: domain.currentManager,
            usesEmail: domain.usesEmail,
            customerWish: domain.customerWish,
            needsOpsReview: domain.needsOpsReview,
            confirmedAt: domain.confirmedAt?.toISOString() ?? null,
          }
        : null,
      sales: { userId: salesUser!.id, displayName: salesUser!.displayName, assignmentId: contract.assignmentId },
      documentRef,
      confirmedBy: auth.value.userId,
      completedAt: now.toISOString(),
    };

    const [completed] = await tx
      .update(contracts)
      .set({
        status: "completed",
        productTermsId: terms.id,
        proposalVersionId: proposalVersionId ?? null,
        documentRef,
        snapshot,
        confirmedBy: auth.value.userId,
        completedAt: now,
      })
      .where(and(eq(contracts.id, contract.id), inArray(contracts.status, [...OPEN_CONTRACT_STATUSES])))
      .returning();
    if (!completed) {
      // 行ロックがあるため通常は起こらない。起きた場合は先に完了した側の報酬を返す
      const [c] = await tx.select().from(contracts).where(eq(contracts.id, contract.id));
      const [r] = await tx.select().from(rewards).where(eq(rewards.contractId, contract.id));
      if (c?.status === "completed" && r) return ok({ contract: c, reward: r, alreadyCompleted: true });
      return err("invalid_state");
    }

    const [inserted] = await tx
      .insert(rewards)
      .values({
        contractId: contract.id,
        userId: contract.salesUserId,
        amount: amount.value,
        status: "accrued",
        accruedAt: now,
        createdAt: now,
      })
      .onConflictDoNothing({ target: rewards.contractId })
      .returning();
    const reward = inserted ?? (await tx.select().from(rewards).where(eq(rewards.contractId, contract.id)))[0]!;

    const [assignmentBefore] = await tx.select().from(assignments).where(eq(assignments.id, contract.assignmentId));
    if (assignmentBefore && assignmentBefore.status !== "completed") {
      await tx
        .update(assignments)
        .set({ status: "completed", lastActivityAt: now })
        .where(eq(assignments.id, contract.assignmentId));
      await recordEvent(tx, clock, {
        actor,
        action: "assignment.status_change",
        targetType: "assignment",
        targetId: contract.assignmentId,
        before: { status: assignmentBefore.status },
        after: { status: "completed", reason: "contract_completed" },
      });
    }

    await recordEvent(tx, clock, {
      actor,
      action: "contract.complete",
      targetType: "contract",
      targetId: contract.id,
      before: { status: contract.status },
      after: { status: "completed", snapshot },
    });
    if (inserted) {
      await recordEvent(tx, clock, {
        actor,
        action: "reward.accrue",
        targetType: "reward",
        targetId: reward.id,
        after: reward,
      });
    }
    return ok({ contract: completed, reward, alreadyCompleted: !inserted });
  });
}

/**
 * 成約報告の差し戻し（運営）。報酬は発生しない。担当は商談中（negotiating）に戻す。
 * TODO(統合)：担当の状態遷移はT2の関数に寄せる。
 */
export async function rejectContract(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: { contractId: string; reason: string },
): Promise<Result<Contract, ContractError>> {
  // 対象を読む前に確かめる（所有者を限定しない確認。営業は常に拒否される）
  const auth = authorizeUser(actor, "confirm", { type: "contract", ownerUserId: null });
  if (!auth.ok) return auth;
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(contracts).where(eq(contracts.id, input.contractId)).for("update");
    if (!before) return err("not_found");
    if (!(OPEN_CONTRACT_STATUSES as readonly string[]).includes(before.status)) return err("invalid_state");
    const now = clock.now();
    const [after] = await tx
      .update(contracts)
      .set({ status: "rejected", closeReason: input.reason.trim() || null, closedAt: now })
      .where(eq(contracts.id, input.contractId))
      .returning();
    const [a] = await tx.select().from(assignments).where(eq(assignments.id, before.assignmentId));
    if (a?.status === "contract_pending") {
      await tx.update(assignments).set({ status: "negotiating", lastActivityAt: now }).where(eq(assignments.id, a.id));
      await recordEvent(tx, clock, {
        actor,
        action: "assignment.status_change",
        targetType: "assignment",
        targetId: a.id,
        before: { status: a.status },
        after: { status: "negotiating", reason: "contract_rejected" },
      });
    }
    await recordEvent(tx, clock, {
      actor,
      action: "contract.reject",
      targetType: "contract",
      targetId: input.contractId,
      before: { status: before.status },
      after: { status: after!.status, reason: after!.closeReason },
    });
    return ok(after!);
  });
}

/** 営業本人は自分の契約を、運営は全件を見られる */
export async function getContractForActor(
  db: DbOrTx,
  actor: Actor,
  contractId: string,
): Promise<Result<Contract, ContractError>> {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  if (!c) return err("not_found");
  const auth = authorizeUser(actor, "read", { type: "contract", ownerUserId: c.salesUserId });
  if (!auth.ok) return auth;
  return ok(c);
}
