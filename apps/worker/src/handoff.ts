import { type Clock, recordEvent } from "@siteoffer/core";
import { type DbOrTx, proposalHandoffs } from "@siteoffer/db";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { WorkerDeps } from "./deps.ts";
import { type ProposalPayload, QUEUES, stepKeys } from "./queues.ts";

const actor = { kind: "system", job: "proposal-handoff" } as const;
export const HANDOFF_LEASE_MS = 60_000;
export const HANDOFF_SEND_TIMEOUT_MS = 10_000;
export const HANDOFF_RETRY_MESSAGE = "提案制作への引き継ぎを確認できませんでした。依頼は保存済みで、自動で再送します。";

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

function retryDelay(attempts: number) {
  return Math.min(300_000, 30_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 4));
}

/** キューへの送信はDBトランザクションの外。応答消失・プロセス消失は同じキーで再送する。 */
export async function dispatchProposalHandoffs(deps: WorkerDeps, sourceStepKey?: string) {
  if (deps.discoveryOnly) return { sent: 0, deferred: 0 };
  const { db, clock } = deps;
  const now = clock.now();
  const rows = await db
    .select({ key: proposalHandoffs.sourceStepKey })
    .from(proposalHandoffs)
    .where(
      and(
        isNull(proposalHandoffs.sentAt),
        lte(proposalHandoffs.nextAttemptAt, now),
        or(isNull(proposalHandoffs.leaseUntil), lte(proposalHandoffs.leaseUntil, now)),
        sourceStepKey ? eq(proposalHandoffs.sourceStepKey, sourceStepKey) : undefined,
      ),
    )
    .orderBy(asc(proposalHandoffs.nextAttemptAt), asc(proposalHandoffs.createdAt))
    .limit(20);
  let sent = 0,
    deferred = 0;
  for (const candidate of rows) {
    const claim = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(proposalHandoffs)
        .where(eq(proposalHandoffs.sourceStepKey, candidate.key))
        .for("update");
      const current = clock.now();
      if (!row || row.sentAt || row.nextAttemptAt > current || (row.leaseUntil && row.leaseUntil > current))
        return null;
      const token = crypto.randomUUID();
      const [claimed] = await tx
        .update(proposalHandoffs)
        .set({
          leaseToken: token,
          leaseUntil: new Date(current.getTime() + HANDOFF_LEASE_MS),
          attempts: row.attempts + 1,
          updatedAt: current,
        })
        .where(eq(proposalHandoffs.sourceStepKey, row.sourceStepKey))
        .returning();
      return claimed!;
    });
    if (!claim) continue;
    const payload: ProposalPayload = { companyId: claim.companyId, auditId: claim.auditId, revision: "initial" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delivered = false;
    try {
      await Promise.race([
        deps.queue.send(QUEUES.proposal, payload, { singletonKey: stepKeys.proposal(payload) }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("handoff timeout")), HANDOFF_SEND_TIMEOUT_MS);
        }),
      ]);
      delivered = true;
    } catch {
      // 通信エラーの詳細は保存しない（接続先や認証情報を含む可能性がある）。
    } finally {
      clearTimeout(timer);
    }
    const recorded = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(proposalHandoffs)
        .where(eq(proposalHandoffs.sourceStepKey, claim.sourceStepKey))
        .for("update");
      const completedAt = clock.now();
      if (
        !current ||
        current.sentAt ||
        current.leaseToken !== claim.leaseToken ||
        !current.leaseUntil ||
        current.leaseUntil <= completedAt
      )
        return false;
      await tx
        .update(proposalHandoffs)
        .set({
          leaseToken: null,
          leaseUntil: null,
          updatedAt: completedAt,
          ...(delivered
            ? { sentAt: completedAt, lastError: null }
            : {
                lastError: HANDOFF_RETRY_MESSAGE,
                nextAttemptAt: new Date(completedAt.getTime() + retryDelay(claim.attempts)),
              }),
        })
        .where(eq(proposalHandoffs.sourceStepKey, claim.sourceStepKey));
      if (delivered)
        await recordEvent(tx, clock, {
          actor,
          action: "pipeline.handoff_sent",
          targetType: "worker_step",
          targetId: claim.sourceStepKey,
          after: { auditId: claim.auditId, attempt: claim.attempts },
        });
      return true;
    });
    if (recorded && delivered) sent++;
    else deferred++;
  }
  return { sent, deferred };
}
