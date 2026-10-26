import { randomUUID } from "node:crypto";
import { fixedClock } from "@siteoffer/core";
import { generationJobs, workerRuntimes } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { afterEach, expect, it } from "vitest";
import { generationStopNextStep } from "./generation-stops";
import { assessWorkers, getProcessingOverview } from "./processing";
import { seedCandidate, seedUser } from "./test-seed";

const clock = fixedClock("2026-10-18T14:00:00Z");
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
function reference(jobId: string) {
  const executionId = randomUUID();
  return {
    executionId,
    jobId,
    containerName: `siteoffer-gen-${executionId}`,
    host: "private-host-test",
    clientPid: 123456789,
    clientClosed: true,
    stopped: false,
  };
}
const worker = { live: true, known: true, site: true, generator: "codex", stopRecovery: true };
it("distinguishes missing evidence, a missing worker, an old worker and a capable worker", () => {
  const id = randomUUID(),
    job = { id, generator: "codex", reference: reference(id) };
  expect(generationStopNextStep({ ...job, reference: null }, [worker]).code).toBe("evidence_missing");
  expect(generationStopNextStep({ ...job, reference: reference(randomUUID()) }, [worker]).code).toBe(
    "evidence_missing",
  );
  expect(
    generationStopNextStep({ ...job, reference: { ...job.reference, clientClosed: false, clientPid: null } }, [worker])
      .code,
  ).toBe("evidence_missing");
  expect(generationStopNextStep(job, []).code).toBe("worker_missing");
  expect(
    generationStopNextStep(job, [
      { ...worker, live: false },
      { ...worker, generator: "mock" },
    ]).code,
  ).toBe("worker_missing");
  expect(generationStopNextStep(job, [{ ...worker, site: false }]).code).toBe("worker_missing");
  expect(generationStopNextStep(job, [{ ...worker, stopRecovery: false }]).code).toBe("worker_update");
  expect(generationStopNextStep(job, [worker]).code).toBe("automatic_check");
});

it("shows global blockers while viewing a different company, paginates all rows, and never returns host evidence or output", async () => {
  const test = await createTestDb();
  close = test.close;
  const { db } = test,
    ops = await seedUser(db, "ops"),
    sales = await seedUser(db, "sales");
  const a = await seedCandidate(db),
    b = await seedCandidate(db);
  await db.insert(workerRuntimes).values({
    id: randomUUID(),
    mode: "standard",
    providers: [],
    heartbeatAt: clock.now(),
    capabilities: {
      version: 1,
      generator: "codex",
      discoveryOnly: false,
      imageConfigured: false,
      intakeIntervalMs: 5000,
      generationStopRecovery: 1,
    },
    progress: {
      phase: "idle",
      since: clock.now().toISOString(),
      completedAt: clock.now().toISOString(),
      lastErrorAt: null,
    },
  });
  const rows = Array.from({ length: 24 }, (_, i) => {
    const id = randomUUID();
    return {
      id,
      idempotencyKey: `global-stop-${i}`,
      companyId: i === 23 ? null : a.company.id,
      purpose: "faq" as const,
      generator: "codex",
      promptVersion: "test",
      status: i === 22 ? ("failed" as const) : ("needs_review" as const),
      errorCode: i === 22 ? "sandbox_stop_confirmed" : "sandbox_stop_unconfirmed",
      outputRef: { stopReference: reference(id), privateSentinel: "private-ref-test" },
      output: { privateSentinel: "untrusted-output-test" },
      error: "private-error-test",
      finishedAt: new Date(clock.now().getTime() + i * 1000),
    };
  });
  await db.insert(generationJobs).values(rows);
  const first = await getProcessingOverview(db, clock, ops.actor, b.company.id);
  if (!first.ok) throw Error(first.error);
  expect(first.value.generationStops).toMatchObject({ total: 23, pages: 2, page: 1 });
  expect(first.value.generationStops.items).toHaveLength(20);
  expect(first.value.generationStops.items[0]).toMatchObject({
    id: rows[0]!.id,
    companyId: a.company.id,
    next: { code: "automatic_check" },
  });
  expect(first.value.site).toMatchObject({ status: "attention", label: "生成の停止確認待ち" });
  for (const sentinel of [
    "private-host-test",
    "private-ref-test",
    "untrusted-output-test",
    "private-error-test",
    "clientPid",
    "stopReference",
  ])
    expect(JSON.stringify(first.value)).not.toContain(sentinel);
  const last = await getProcessingOverview(db, clock, ops.actor, b.company.id, { stops: 999 });
  if (!last.ok) throw Error(last.error);
  expect(last.value.generationStops).toMatchObject({ page: 2, total: 23 });
  expect(last.value.generationStops.items.map((r) => r.id)).toEqual([rows[20]!.id, rows[21]!.id, rows[23]!.id]);
  expect(last.value.generationStops.items.at(-1)?.companyName).toBeNull();
  const negative = await getProcessingOverview(db, clock, ops.actor, undefined, { stops: -1 });
  expect(negative.ok && negative.value.generationStops.page).toBe(1);
  expect(await getProcessingOverview(db, clock, sales.actor)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await getProcessingOverview(db, clock, null)).toMatchObject({ ok: false, error: "forbidden" });
});

it("does not flag an unrelated generator or mark image generation as stopped", () => {
  const runtime = {
    id: randomUUID(),
    mode: "standard",
    providers: [],
    heartbeatAt: clock.now(),
    capabilities: {
      version: 1 as const,
      generator: "mock" as const,
      discoveryOnly: false,
      imageConfigured: true,
      intakeIntervalMs: 5000,
    },
    progress: {
      phase: "idle" as const,
      since: clock.now().toISOString(),
      completedAt: clock.now().toISOString(),
      lastErrorAt: null,
    },
  };
  expect(assessWorkers([runtime], clock.now(), ["codex"]).site.status).toBe("ready");
  expect(assessWorkers([runtime], clock.now(), ["mock"]).site.status).toBe("attention");
  expect(assessWorkers([runtime], clock.now(), ["mock"]).image.status).toBe("ready");
  expect(assessWorkers([runtime], clock.now()).workers[0]?.stopRecovery).toBe(false);
});
