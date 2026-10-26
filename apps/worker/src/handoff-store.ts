import { type Clock, recordEvent } from "@siteoffer/core";
import { type DbOrTx, proposalHandoffs } from "@siteoffer/db";
import { eq } from "drizzle-orm";

const actor = { kind: "system", job: "proposal-handoff" } as const;

export async function findProposalHandoff(db: DbOrTx, key: string) {
  const [row] = await db.select().from(proposalHandoffs).where(eq(proposalHandoffs.sourceStepKey, key));
  return row ?? null;
}

/** 呼び出し側の業務トランザクション内で保存する。再送時に診断を差し替えない。 */
export async function recordProposalHandoff(
  db: DbOrTx,
  clock: Clock,
  input: {
    sourceStepKey: string;
    companyId: string;
    auditId: string;
  },
) {
  const [created] = await db
    .insert(proposalHandoffs)
    .values({ ...input, nextAttemptAt: clock.now(), createdAt: clock.now(), updatedAt: clock.now() })
    .onConflictDoNothing({ target: proposalHandoffs.sourceStepKey })
    .returning();
  const row = created ?? (await findProposalHandoff(db, input.sourceStepKey));
  if (!row || row.companyId !== input.companyId || row.auditId !== input.auditId) {
    throw new Error("保存済みの引き継ぎと診断が一致しません");
  }
  if (created)
    await recordEvent(db, clock, {
      actor,
      action: "pipeline.handoff_requested",
      targetType: "worker_step",
      targetId: input.sourceStepKey,
      after: { companyId: input.companyId, auditId: input.auditId },
    });
  return row;
}
