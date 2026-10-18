import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { fixedClock } from "@siteoffer/core";
import { auditEvents, generationJobs } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { saveGenerationStopReference } from "../src/execution-reference.ts";
import { runGenerationJob } from "../src/jobs.ts";
import { GENERATION_LEASE_MS, GenerationLeaseLost, recoverExpiredGenerationJobs } from "../src/lease.ts";
import { MockGenerator } from "../src/mock.ts";
import type { SandboxStopReference } from "../src/sandbox/types.ts";
import { recoverUnconfirmedGenerationJobs } from "../src/stop-recovery.ts";
import type { Generator } from "../src/types.ts";
import { fixtureInput } from "./helpers.ts";

let test: Awaited<ReturnType<typeof createTestDb>>, clock: ReturnType<typeof fixedClock>;
beforeEach(async () => {
  test = await createTestDb();
  clock = fixedClock("2026-10-18T15:00:00Z");
});
afterEach(async () => {
  await test.close();
});
function reference(jobId: string): SandboxStopReference {
  const executionId = randomUUID();
  return {
    executionId,
    jobId,
    containerName: `siteoffer-gen-${executionId}`,
    host: hostname(),
    clientPid: null,
    clientClosed: false,
    stopped: false,
  };
}
async function seed() {
  const [job] = await test.db
    .insert(generationJobs)
    .values({
      idempotencyKey: randomUUID(),
      generator: "codex",
      purpose: "faq",
      promptVersion: "test",
      status: "running",
      attempts: 1,
      leaseUntil: new Date(clock.now().getTime() + GENERATION_LEASE_MS),
    })
    .returning();
  return job!;
}
it("stores evidence before a crash, fences another process even before sweeping, and never re-runs the lost job", async () => {
  const { db } = test,
    job = await seed(),
    ref = { ...reference(job.id), clientPid: 1234567 };
  await saveGenerationStopReference(db, clock, job.id, 1, ref);
  clock.advance(GENERATION_LEASE_MS + 1);
  let calls = 0;
  const generator: Generator = {
    kind: "codex",
    requestedModel: null,
    promptVersion: () => "test",
    generate: (req) => {
      calls++;
      return new MockGenerator().generate(req);
    },
    recoverStop: async () => true,
  };
  const deps = { db, clock, generator };
  expect(
    await runGenerationJob(deps, {
      idempotencyKey: "new-after-crash",
      companyId: null,
      purpose: "faq",
      input: fixtureInput(),
    }),
  ).toMatchObject({ ok: false, error: "sandbox_stop_pending" });
  expect(calls).toBe(0);
  expect(await recoverExpiredGenerationJobs(db, clock)).toEqual([job.id]);
  expect((await db.select().from(generationJobs).where(eq(generationJobs.id, job.id)))[0]).toMatchObject({
    status: "needs_review",
    errorCode: "sandbox_stop_unconfirmed",
    output: null,
    outputRef: { stopReference: ref },
  });
  expect(await recoverExpiredGenerationJobs(db, clock)).toEqual([]);
  expect((await db.select().from(auditEvents)).filter((e) => e.action === "generation.stop_unconfirmed")).toHaveLength(
    1,
  );
  expect(await recoverUnconfirmedGenerationJobs(deps)).toEqual([job.id]);
  expect(calls).toBe(0);
  expect(
    (
      await runGenerationJob(deps, {
        idempotencyKey: "new-after-confirmation",
        companyId: null,
        purpose: "faq",
        input: fixtureInput(),
      })
    ).ok,
  ).toBe(true);
  expect(calls).toBe(1);
});
it("late terminal evidence can close an expired execution, while older attempts and foreign job identities cannot overwrite it", async () => {
  const { db } = test,
    job = await seed(),
    ref = reference(job.id);
  await saveGenerationStopReference(db, clock, job.id, 1, ref);
  clock.advance(GENERATION_LEASE_MS + 1);
  await recoverExpiredGenerationJobs(db, clock);
  const terminal = { ...ref, clientClosed: true, stopped: true };
  await saveGenerationStopReference(db, clock, job.id, 1, terminal);
  await expect(saveGenerationStopReference(db, clock, job.id, 2, terminal)).rejects.toBeInstanceOf(GenerationLeaseLost);
  await expect(saveGenerationStopReference(db, clock, job.id, 1, reference(randomUUID()))).rejects.toBeInstanceOf(
    GenerationLeaseLost,
  );
  expect((await db.select().from(generationJobs).where(eq(generationJobs.id, job.id)))[0]?.outputRef).toEqual({
    stopReference: terminal,
  });
});
it("PID persistence cannot regress terminal proof or replace a still-unconfirmed execution", async () => {
  const { db } = test,
    job = await seed(),
    ref = reference(job.id);
  await saveGenerationStopReference(db, clock, job.id, 1, ref);
  await expect(saveGenerationStopReference(db, clock, job.id, 1, reference(job.id))).rejects.toBeInstanceOf(
    GenerationLeaseLost,
  );
  const terminal = { ...ref, clientPid: 123456, clientClosed: true, stopped: true };
  await saveGenerationStopReference(db, clock, job.id, 1, terminal);
  await saveGenerationStopReference(db, clock, job.id, 1, { ...ref, clientPid: 123456 });
  expect((await db.select().from(generationJobs).where(eq(generationJobs.id, job.id)))[0]?.outputRef).toEqual({
    stopReference: terminal,
  });
});
it("a legacy running Codex job without a lease is quarantined, while queued jobs and confirmed stopped executions close without adopting output", async () => {
  const { db } = test,
    unknown = await seed(),
    queued = await seed(),
    stopped = await seed();
  const ref = { ...reference(stopped.id), clientClosed: true, stopped: true };
  await db.update(generationJobs).set({ leaseUntil: null }).where(eq(generationJobs.id, unknown.id));
  await db
    .update(generationJobs)
    .set({ status: "queued", attempts: 0, leaseUntil: clock.now() })
    .where(eq(generationJobs.id, queued.id));
  await db
    .update(generationJobs)
    .set({ leaseUntil: clock.now(), outputRef: { stopReference: ref } })
    .where(eq(generationJobs.id, stopped.id));
  expect((await recoverExpiredGenerationJobs(db, clock)).sort()).toEqual([unknown.id, queued.id, stopped.id].sort());
  const rows = await db.select().from(generationJobs);
  expect(rows.find((r) => r.id === unknown.id)).toMatchObject({
    status: "needs_review",
    errorCode: "sandbox_stop_unconfirmed",
  });
  for (const id of [queued.id, stopped.id])
    expect(rows.find((r) => r.id === id)).toMatchObject({ status: "failed", errorCode: "interrupted", output: null });
});
