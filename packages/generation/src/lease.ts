import { type Clock, recordEvent } from "@siteoffer/core";
import { type DbOrTx, generationJobs } from "@siteoffer/db";
import { and, asc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { sandboxStopReferenceSchema } from "./sandbox/types.ts";

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

/** Expired Codex executions remain quarantined until host termination evidence is confirmed. */
export async function recoverExpiredGenerationJobs(db: DbOrTx, clock: Clock, jobId?: string) {
  return db.transaction(async (tx) => {
    const now = clock.now();
    const expired = and(
      activeGeneration(),
      or(
        lte(generationJobs.leaseUntil, now),
        and(
          eq(generationJobs.generator, "codex"),
          eq(generationJobs.status, "running"),
          isNull(generationJobs.leaseUntil),
        ),
      ),
    );
    const candidates = await tx
      .select({ id: generationJobs.id })
      .from(generationJobs)
      .where(and(expired, jobId ? eq(generationJobs.id, jobId) : undefined))
      .orderBy(asc(generationJobs.leaseUntil), asc(generationJobs.id))
      .limit(100);
    if (!candidates.length) return [];
    // 候補取得後に延長・完了されたジョブは更新条件を再照合して除外する。
    const closed: string[] = [];
    for (const candidate of candidates) {
      const [row] = await tx
        .select()
        .from(generationJobs)
        .where(and(expired, eq(generationJobs.id, candidate.id)))
        .for("update");
      if (!row) continue;
      const proof = sandboxStopReferenceSchema.safeParse(
        (row.outputRef as { stopReference?: unknown } | null)?.stopReference,
      );
      const confirmed = proof.success && proof.data.jobId === row.id && proof.data.stopped;
      const unconfirmed = row.generator === "codex" && row.status === "running" && !confirmed;
      const status = unconfirmed ? ("needs_review" as const) : ("failed" as const);
      const errorCode = unconfirmed ? "sandbox_stop_unconfirmed" : "interrupted";
      const [updated] = await tx
        .update(generationJobs)
        .set({
          status,
          errorCode,
          error: unconfirmed
            ? "生成処理との接続が途切れ、停止を確認できません。元の実行環境を確認するまで新しい生成を保留します。"
            : GENERATION_INTERRUPTED_MESSAGE,
          output: null,
          leaseUntil: null,
          finishedAt: now,
        })
        .where(and(expired, eq(generationJobs.id, candidate.id)))
        .returning({ id: generationJobs.id });
      if (!updated) continue;
      closed.push(updated.id);
      await recordEvent(tx, clock, {
        actor: { kind: "system", job: "generation-recovery" },
        action: unconfirmed ? "generation.stop_unconfirmed" : "generation.interrupted",
        targetType: "generation_job",
        targetId: row.id,
        after: { status, errorCode },
      });
    }
    return closed;
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
