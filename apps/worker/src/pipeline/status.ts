import { type Actor, type Clock, recordEvent } from "@siteoffer/core";
import { companies, type DbOrTx } from "@siteoffer/db";
import { and, eq, inArray } from "drizzle-orm";

export type PipelineStatus = (typeof companies.$inferSelect)["pipelineStatus"];

export const PIPELINE_ACTOR: Actor = { kind: "system", job: "pipeline" };

/** 営業可能・運営確認待ちの企業を、ワーカーの処理で前の段階へ戻さない */
export const PRE_REVIEW_STATUSES: PipelineStatus[] = [
  "collected",
  "site_confirmed",
  "audited",
  "generated",
  "on_hold",
  "failed",
];

/** 再収集・再診断でも処理しない営業抑止（discovery の PROTECTED_SUPPRESSIONS と同じ） */
export const PROTECTED: (typeof companies.$inferSelect)["suppression"][] = [
  "do_not_contact",
  "excluded",
  "existing_customer",
];

/**
 * 企業の pipelineStatus を from のいずれかから to へ進める（比較して更新。読み取り後に変わっていれば何もしない）。
 * 変えたときだけ操作履歴を残し、true を返す。
 */
export async function moveCompanyStatus(
  db: DbOrTx,
  clock: Clock,
  input: {
    companyId: string;
    from: PipelineStatus[];
    to: PipelineStatus;
    reason: string;
    meta?: Record<string, unknown>;
  },
): Promise<boolean> {
  const run = async (tx: DbOrTx) => {
    const [before] = await tx
      .select({ status: companies.pipelineStatus })
      .from(companies)
      .where(eq(companies.id, input.companyId));
    if (!before || before.status === input.to || !input.from.includes(before.status)) return false;
    const [updated] = await tx
      .update(companies)
      .set({ pipelineStatus: input.to, updatedAt: clock.now() })
      .where(and(eq(companies.id, input.companyId), inArray(companies.pipelineStatus, [before.status])))
      .returning({ id: companies.id });
    if (!updated) return false;
    await recordEvent(tx, clock, {
      actor: PIPELINE_ACTOR,
      action: "company.pipeline_status_changed",
      targetType: "company",
      targetId: input.companyId,
      before: { pipelineStatus: before.status },
      after: { pipelineStatus: input.to, reason: input.reason, ...input.meta },
    });
    return true;
  };
  return db.transaction(run);
}
