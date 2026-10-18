import { type Clock, recordEvent } from "@siteoffer/core";
import { type Db, type DbOrTx, generationJobs } from "@siteoffer/db";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { sandboxStopReferenceSchema } from "./sandbox/types.ts";
import type { Generator, GeneratorResult } from "./types.ts";

const unresolved = (kind: string) =>
  and(
    eq(generationJobs.generator, kind),
    eq(generationJobs.status, "needs_review"),
    eq(generationJobs.errorCode, "sandbox_stop_unconfirmed"),
  );

export async function hasUnconfirmedGenerationStop(db: DbOrTx, kind: string, now: Date) {
  const rows = await db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(
      or(
        unresolved(kind),
        kind === "codex"
          ? and(
              eq(generationJobs.generator, kind),
              eq(generationJobs.status, "running"),
              or(isNull(generationJobs.leaseUntil), lte(generationJobs.leaseUntil, now)),
            )
          : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** A late result can supply termination evidence, never generated output. */
export async function rememberLateGenerationStop(
  db: Db,
  clock: Clock,
  jobId: string,
  result: GeneratorResult<unknown>,
) {
  const parsed = sandboxStopReferenceSchema.safeParse(result.stopReference);
  if (!parsed.success || parsed.data.jobId !== jobId) return;
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(generationJobs)
      .set({
        outputRef: { stopReference: parsed.data },
        threadId: result.record.threadId,
        usage: result.record.usage,
        responseModel: result.record.responseModel,
        sdkVersion: result.record.sdkVersion,
        cliVersion: result.record.cliVersion,
      })
      .where(and(eq(generationJobs.id, jobId), unresolved(result.record.generator)))
      .returning({ id: generationJobs.id });
    if (updated)
      await recordEvent(tx, clock, {
        actor: { kind: "system", job: "generation-recovery" },
        action: "generation.late_stop_evidence",
        targetType: "generation_job",
        targetId: jobId,
        after: { stopped: parsed.data.stopped },
      });
  });
}

/** Bounded housekeeping. Confirm only an owned execution; do not re-run the model or adopt its output. */
export async function recoverUnconfirmedGenerationJobs(deps: { db: Db; clock: Clock; generator: Generator }) {
  if (!deps.generator.recoverStop) return [];
  const candidates = await deps.db
    .select()
    .from(generationJobs)
    .where(unresolved(deps.generator.kind))
    .orderBy(asc(generationJobs.finishedAt), asc(generationJobs.id))
    .limit(20);
  for (const job of candidates) {
    const raw = (job.outputRef as { stopReference?: unknown } | null)?.stopReference;
    const parsed = sandboxStopReferenceSchema.safeParse(raw);
    if (!parsed.success || parsed.data.jobId !== job.id) continue;
    let stopped = false;
    try {
      stopped = await deps.generator.recoverStop(parsed.data);
    } catch {
      /* Preserve the gate. */
    }
    if (!stopped) return [];
    return deps.db.transaction(async (tx) => {
      const rows = await tx
        .update(generationJobs)
        .set({
          status: "failed",
          errorCode: "sandbox_stop_confirmed",
          error: "生成の停止を確認しました。遅れて返った結果は採用していません。元の依頼から再試行できます。",
          output: null,
          outputRef: { stopReference: { ...parsed.data, stopped: true } },
          leaseUntil: null,
        })
        .where(and(eq(generationJobs.id, job.id), unresolved(deps.generator.kind)))
        .returning({ id: generationJobs.id });
      for (const row of rows)
        await recordEvent(tx, deps.clock, {
          actor: { kind: "system", job: "generation-recovery" },
          action: "generation.stop_confirmed",
          targetType: "generation_job",
          targetId: row.id,
          after: { status: "failed", errorCode: "sandbox_stop_confirmed" },
        });
      return rows.map((r) => r.id);
    });
  }
  return [];
}
