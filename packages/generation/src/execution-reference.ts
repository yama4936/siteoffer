import type { Clock } from "@siteoffer/core";
import { type Db, generationJobs } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import { GenerationLeaseLost } from "./lease.ts";
import { type SandboxStopReference, sandboxStopReferenceSchema } from "./sandbox/types.ts";

/** Store host evidence without adopting output. Older attempts may never replace the current execution. */
export async function saveGenerationStopReference(
  db: Db,
  clock: Clock,
  jobId: string,
  attempt: number,
  raw: SandboxStopReference,
) {
  const parsed = sandboxStopReferenceSchema.safeParse(raw);
  if (!parsed.success || parsed.data.jobId !== jobId) throw new GenerationLeaseLost();
  const next = parsed.data;
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(generationJobs).where(eq(generationJobs.id, jobId)).for("update");
    if (!row || row.attempts !== attempt) throw new GenerationLeaseLost();
    const previous = sandboxStopReferenceSchema.safeParse(
      (row.outputRef as { stopReference?: unknown } | null)?.stopReference,
    );
    const same = previous.success && previous.data.executionId === next.executionId;
    const owned = row.status === "running" && !!row.leaseUntil && row.leaseUntil > clock.now();
    const terminalEvidence =
      ((next.clientClosed && same) || (next.stopped && (same || !previous.success))) &&
      (row.status === "running" ||
        (row.status === "needs_review" && row.errorCode === "sandbox_stop_unconfirmed") ||
        (row.status === "failed" && row.errorCode === "interrupted"));
    if (!owned && !terminalEvidence) throw new GenerationLeaseLost();
    if (previous.success && !same && !previous.data.stopped) throw new GenerationLeaseLost();
    // A delayed PID registration must not undo terminal evidence from the same execution.
    if (
      same &&
      previous.success &&
      ((previous.data.stopped && !next.stopped) || (previous.data.clientClosed && !next.clientClosed))
    )
      return;
    await tx
      .update(generationJobs)
      .set({ outputRef: { stopReference: next } })
      .where(eq(generationJobs.id, jobId));
  });
}
