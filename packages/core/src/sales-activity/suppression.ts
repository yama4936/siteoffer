import { ACTIVE_ASSIGNMENT_STATUSES, assignments, companies, type DbOrTx } from "@siteoffer/db";
import { and, eq, inArray } from "drizzle-orm";
import { runTx, snapshot } from "../assignment/shared.ts";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, type Result } from "../common/result.ts";
import { authorizeUser, requireUser } from "../permissions/policy.ts";
import { cancelOfferChangesOnAssignmentEnd } from "../sales-offer/lifecycle.ts";

type Company = typeof companies.$inferSelect;
export type Suppression = Company["suppression"];
/** 営業ユーザーが記録できる営業拒否。「今は不要」と「今後連絡しないで」を区別する（12.3） */
export type DeclineKind = Extract<Suppression, "not_now" | "do_not_contact">;

/** 抑止の強さ。営業ユーザーは強める方向にだけ変更できる */
const STRENGTH: Record<Suppression, number> = {
  none: 0,
  not_now: 1,
  do_not_contact: 2,
  excluded: 3,
  existing_customer: 3,
};

export interface SuppressInput {
  companyId: string;
  kind: Exclude<Suppression, "none">;
  reason?: string;
  /** 「今は不要」のとき、企業が示した再連絡の目安。抑止を自動では解除しない（解除は運営だけ） */
  recontactAfter?: Date;
}

export type SuppressError = "forbidden" | "company_not_found" | "stronger_suppression_exists" | "invalid_input";

/**
 * 企業共通の営業抑止を書き込む（トランザクション内で呼ぶ）。
 * 有効な担当があれば終了させる（企業共通の抑止のため、担当者に関係なく全員の新規確保を止める）。
 * 抑止の値は companies に持ち、担当の解除や再収集では消さない。
 */
export async function applySuppression(
  tx: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: SuppressInput,
  assignmentEnd: { status: "lost" | "released"; reason: string },
): Promise<Result<Company, SuppressError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  // 業務条件：営業が記録できる抑止の種類は2つだけ（除外・既存顧客は運営が記録する）
  if (actor.kind === "sales" && input.kind !== "not_now" && input.kind !== "do_not_contact") {
    return err("forbidden", "営業ユーザーが記録できるのは「今は不要」「今後連絡しないで」だけです");
  }
  if (input.kind !== "not_now" && input.recontactAfter) {
    return err("invalid_input", "再連絡の目安は「今は不要」のときだけ記録できます");
  }

  const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).for("update");
  if (!company) return err("company_not_found");

  const active = await tx
    .select()
    .from(assignments)
    .where(and(eq(assignments.companyId, company.id), inArray(assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES])))
    .for("update");
  // 権限：企業の report_refusal。有効な担当は一意制約で高々1件
  const auth = authorizeUser(
    actor,
    "report_refusal",
    {
      type: "company",
      companyId: company.id,
      sellable: company.pipelineStatus === "sellable",
      assignedUserId: active[0]?.userId ?? null,
    },
    "自分が担当している企業だけ営業拒否を記録できます",
  );
  if (!auth.ok) return auth;
  // 業務条件：営業は抑止を強める方向にだけ変更できる
  if (actor.kind === "sales" && STRENGTH[company.suppression] > STRENGTH[input.kind]) {
    return err("stronger_suppression_exists", `既に${company.suppression}が記録されています`);
  }

  const now = clock.now();
  const [updated] = await tx
    .update(companies)
    .set({
      suppression: input.kind,
      suppressionReason: input.reason ?? null,
      suppressionUpdatedAt: now,
      recontactAfter: input.kind === "not_now" ? (input.recontactAfter ?? null) : null,
      updatedAt: now,
    })
    .where(eq(companies.id, company.id))
    .returning();
  await recordEvent(tx, clock, {
    actor,
    action: "company.suppress",
    targetType: "company",
    targetId: company.id,
    before: suppressionSnapshot(company),
    after: suppressionSnapshot(updated!),
  });

  for (const a of active) {
    const [ended] = await tx
      .update(assignments)
      .set({ status: assignmentEnd.status, releasedAt: now, releaseReason: assignmentEnd.reason })
      .where(eq(assignments.id, a.id))
      .returning();
    await cancelOfferChangesOnAssignmentEnd(tx, clock, actor, a.id, "営業抑止により担当が終了しました。");
    await recordEvent(tx, clock, {
      actor,
      action: "assignment.end_by_suppression",
      targetType: "assignment",
      targetId: a.id,
      before: snapshot(a),
      after: snapshot(ended!),
    });
  }
  return { ok: true, value: updated! };
}

/**
 * 営業抑止の記録（単独操作）。営業は自分の担当企業に「今は不要」「今後連絡しないで」を記録できる。
 * 運営は全企業に、除外（excluded）・既存顧客（existing_customer）を含めて記録できる。
 * 営業から記録するときは、活動記録の declined（recordActivity）を使うと活動履歴も残る。
 */
export async function suppressCompany(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: SuppressInput,
): Promise<Result<Company, SuppressError>> {
  return runTx<Company, SuppressError>(db, async (tx, fail) => {
    const r = await applySuppression(tx, clock, actor, input, {
      status: actor.kind === "ops" ? "released" : "lost",
      reason: `suppressed:${input.kind}`,
    });
    if (!r.ok) return fail(r.error, r.message);
    return r.value;
  });
}

export type LiftError = "forbidden" | "company_not_found" | "not_suppressed";

/** 営業抑止の解除。運営だけが行える。「今は不要」の再連絡目安を過ぎても自動では解除しない */
export async function liftSuppression(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: { companyId: string; reason: string },
): Promise<Result<Company, LiftError>> {
  const user = requireUser(actor, "営業抑止の解除は運営だけが行えます");
  if (!user.ok) return user;
  return runTx<Company, LiftError>(db, async (tx, fail) => {
    const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).for("update");
    if (!company) return fail("company_not_found");
    // 権限：企業の manage。属性は読んだ企業の行と有効な担当から渡す
    const [active] = await tx
      .select({ userId: assignments.userId })
      .from(assignments)
      .where(and(eq(assignments.companyId, company.id), inArray(assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES])));
    const auth = authorizeUser(
      actor,
      "manage",
      {
        type: "company",
        companyId: company.id,
        sellable: company.pipelineStatus === "sellable",
        assignedUserId: active?.userId ?? null,
      },
      "営業抑止の解除は運営だけが行えます",
    );
    if (!auth.ok) return fail(auth.error, auth.message);
    if (company.suppression === "none") fail("not_suppressed");
    const now = clock.now();
    const [updated] = await tx
      .update(companies)
      .set({
        suppression: "none",
        suppressionReason: null,
        suppressionUpdatedAt: now,
        recontactAfter: null,
        updatedAt: now,
      })
      .where(eq(companies.id, company.id))
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "company.lift_suppression",
      targetType: "company",
      targetId: company.id,
      before: suppressionSnapshot(company),
      after: { ...suppressionSnapshot(updated!), reason: input.reason },
    });
    return updated!;
  });
}

function suppressionSnapshot(c: Company) {
  return {
    suppression: c.suppression,
    suppressionReason: c.suppressionReason,
    recontactAfter: c.recontactAfter?.toISOString() ?? null,
  };
}
