import { type Clock, recordEvent } from "@siteoffer/core";
import { type DbOrTx, generationJobs } from "@siteoffer/db";
import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";

export const GENERATION_LEASE_MS = 120_000;
export const GENERATION_HEARTBEAT_MS = 20_000;
export const GENERATION_INTERRUPTED_MESSAGE =
  "生成処理との接続が途切れました。ワーカーの稼働と、元の制作・診断の状態を確認してください。";
export class GenerationLeaseLost extends Error {}

export const activeGeneration = () => inArray(generationJobs.status, ["queued", "running"]);
export const ownedGeneration = (id: string, now: Date) =>
  and(eq(generationJobs.id, id), activeGeneration(), gt(generationJobs.leaseUntil, now));

/** 同じジョブを再取得して再実行することはない。作成した呼び出しだけが未期限切れのジョブを延長する。 */
export async function renewGenerationLease(db: DbOrTx, clock: Clock, id: string) {
  return db.transaction(async (tx) => {
    await tx.select({ id: generationJobs.id }).from(generationJobs).where(eq(generationJobs.id, id)).for("update");
    const now = clock.now();
    const rows = await tx
      .update(generationJobs)
      .set({ leaseUntil: new Date(now.getTime() + GENERATION_LEASE_MS) })
      .where(ownedGeneration(id, now))
      .returning({ id: generationJobs.id });
    return rows.length === 1;
  });
}

/** 期限を過ぎた未完了ジョブだけを失敗にする。成功済みの出力や同じ依頼を再実行しない。 */
export async function recoverExpiredGenerationJobs(db: DbOrTx, clock: Clock, jobId?: string) {
  return db.transaction(async (tx) => {
    const now = clock.now();
    const expired = and(activeGeneration(), lte(generationJobs.leaseUntil, now));
    const candidates = await tx
      .select({ id: generationJobs.id })
      .from(generationJobs)
      .where(and(expired, jobId ? eq(generationJobs.id, jobId) : undefined))
      .orderBy(asc(generationJobs.leaseUntil), asc(generationJobs.id))
      .limit(100);
    if (!candidates.length) return [];
    // 候補取得後に延長・完了されたジョブは更新条件を再照合して除外する。
    const closed = await tx
      .update(generationJobs)
      .set({
        status: "failed",
        errorCode: "interrupted",
        error: GENERATION_INTERRUPTED_MESSAGE,
        leaseUntil: null,
        finishedAt: now,
      })
      .where(
        and(
          expired,
          inArray(
            generationJobs.id,
            candidates.map((r) => r.id),
          ),
        ),
      )
      .returning({ id: generationJobs.id });
    for (const row of closed)
      await recordEvent(tx, clock, {
        actor: { kind: "system", job: "generation-recovery" },
        action: "generation.interrupted",
        targetType: "generation_job",
        targetId: row.id,
        after: { status: "failed", errorCode: "interrupted" },
      });
    return closed.map((r) => r.id);
  });
}

/** GETでDBを書き換えず、掃除ジョブが動いていない場合も期限切れを表示する。 */
export function generationConnectionLost(
  job: Pick<typeof generationJobs.$inferSelect, "status" | "leaseUntil" | "errorCode">,
  now: Date,
) {
  return (
    job.errorCode === "interrupted" ||
    ((job.status === "queued" || job.status === "running") && !!job.leaseUntil && job.leaseUntil <= now)
  );
}
