import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { fixedClock } from "@siteoffer/core";
import { auditEvents, generationJobs } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyRecord } from "../src/attempt.ts";
import { runGenerationJob } from "../src/jobs.ts";
import { ConcurrencyLimiter } from "../src/limiter.ts";
import { MockGenerator } from "../src/mock.ts";
import type { SandboxStopReference } from "../src/sandbox/types.ts";
import { recoverUnconfirmedGenerationJobs } from "../src/stop-recovery.ts";
import type { Generator, GeneratorResult } from "../src/types.ts";
import { fixtureInput } from "./helpers.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const clock = fixedClock("2026-10-18T07:00:00Z");
let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  testDb = await createTestDb();
});
afterEach(async () => {
  await testDb.close();
});
const request = (idempotencyKey: string) => ({
  idempotencyKey,
  companyId: null,
  purpose: "faq" as const,
  input: fixtureInput(),
});
const reference = (jobId: string, stopped = false): SandboxStopReference => {
  const executionId = randomUUID();
  return {
    executionId,
    jobId,
    containerName: `siteoffer-gen-${executionId}`,
    host: hostname(),
    clientPid: null,
    clientClosed: true,
    stopped,
  };
};

it("keeps the slot until timeout cleanup finishes, then retries without overlap and discards the late success", async () => {
  const { db } = testDb,
    limiter = new ConcurrencyLimiter(1),
    gate = deferred<void>(),
    cancelled = deferred<void>();
  let calls = 0,
    active = 0,
    peak = 0;
  const generator: Generator = {
    kind: "cleanup-test",
    requestedModel: null,
    promptVersion: () => "test",
    async generate(req) {
      calls++;
      active++;
      peak = Math.max(peak, active);
      try {
        if (calls === 1) {
          await new Promise<void>((resolve) =>
            req.signal!.addEventListener(
              "abort",
              () => {
                cancelled.resolve();
                resolve();
              },
              { once: true },
            ),
          );
          await gate.promise;
          const result = await new MockGenerator().generate({ ...req, signal: undefined });
          return { ...result, record: { ...result.record, threadId: "late-first", usage: { input_tokens: 7 } } };
        }
        return await new MockGenerator().generate(req);
      } finally {
        active--;
      }
    },
  };
  const deps = { db, clock, generator, limiter, limits: { maxAttempts: 2, timeoutMs: 30, stopTimeoutMs: 1000 } };
  const first = runGenerationJob(deps, request("first"));
  await cancelled.promise;
  const second = runGenerationJob(deps, request("second"));
  await expect.poll(async () => (await db.select().from(generationJobs)).length).toBe(2);
  expect(calls).toBe(1);
  expect(limiter.active).toBe(1);
  gate.resolve();
  const results = await Promise.all([first, second]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(calls).toBe(3);
  expect(peak).toBe(1);
  expect(limiter.active).toBe(0);
  const events = await db.select().from(auditEvents);
  expect(events.find((e) => e.action === "generation.attempt_failed")?.after).toMatchObject({
    errorCode: "timeout",
    threadId: "late-first",
  });
  expect(
    events.filter((e) => e.action === "generation.succeeded").map((e) => (e.after as { threadId?: string }).threadId),
  ).not.toContain("late-first");
});

it("persists an unresolved stop, blocks a waiting/new request, and resumes only after owned stop recovery", async () => {
  const { db } = testDb,
    recoverStop = vi.fn(async () => false);
  let calls = 0;
  const generator: Generator = {
    kind: "stop-test",
    requestedModel: null,
    promptVersion: () => "test",
    recoverStop,
    async generate(req) {
      calls++;
      if (calls === 1)
        return {
          ok: false,
          error: "sandbox_stop_unconfirmed",
          message: "stop unknown",
          record: emptyRecord(generator, req.purpose),
          stopReference: reference(req.jobId),
        };
      return new MockGenerator().generate(req);
    },
  };
  const deps = { db, clock, generator, limits: { maxAttempts: 3 } };
  expect(await runGenerationJob(deps, request("unknown"))).toMatchObject({
    ok: false,
    error: "sandbox_stop_unconfirmed",
  });
  expect(await runGenerationJob(deps, request("blocked"))).toMatchObject({ ok: false, error: "sandbox_stop_pending" });
  expect(await runGenerationJob(deps, request("unknown"))).toMatchObject({
    ok: false,
    error: "sandbox_stop_unconfirmed",
  });
  expect(calls).toBe(1);
  expect(await db.select().from(generationJobs).where(eq(generationJobs.idempotencyKey, "blocked"))).toMatchObject([
    { status: "failed", attempts: 0, errorCode: "sandbox_stop_pending", output: null },
  ]);
  expect(await recoverUnconfirmedGenerationJobs(deps)).toEqual([]);
  recoverStop.mockResolvedValue(true);
  expect(await recoverUnconfirmedGenerationJobs(deps)).toHaveLength(1);
  expect(calls).toBe(1);
  expect(await db.select().from(generationJobs).where(eq(generationJobs.idempotencyKey, "unknown"))).toMatchObject([
    { status: "failed", errorCode: "sandbox_stop_confirmed", output: null },
  ]);
  expect((await runGenerationJob(deps, request("after-confirmation"))).ok).toBe(true);
  expect(calls).toBe(2);
});

it("retains only stop evidence and usage from a result arriving after the stop deadline", async () => {
  const { db } = testDb,
    late = deferred<GeneratorResult<never>>();
  let jobId = "";
  const generator: Generator = {
    kind: "late-test",
    requestedModel: null,
    promptVersion: () => "test",
    generate: (req) => {
      jobId = req.jobId;
      return late.promise;
    },
    recoverStop: async (ref) => ref.stopped,
  };
  const deps = { db, clock, generator, limits: { timeoutMs: 10, stopTimeoutMs: 10 } };
  expect(await runGenerationJob(deps, request("too-late"))).toMatchObject({
    ok: false,
    error: "sandbox_stop_unconfirmed",
  });
  late.resolve({
    ok: true,
    output: { mustNeverBeSaved: true } as never,
    record: { ...emptyRecord(generator, "faq"), usage: { input_tokens: 11 } },
    stopReference: reference(jobId, true),
  });
  await expect.poll(async () => (await db.select().from(generationJobs))[0]?.usage).toEqual({ input_tokens: 11 });
  expect((await db.select().from(generationJobs))[0]).toMatchObject({ status: "needs_review", output: null });
  expect(await recoverUnconfirmedGenerationJobs(deps)).toEqual([jobId]);
  expect((await db.select().from(generationJobs))[0]).toMatchObject({
    status: "failed",
    output: null,
    errorCode: "sandbox_stop_confirmed",
  });
});

it("does not turn a thrown generator failure into an automatic retry or leak its raw error", async () => {
  const { db } = testDb,
    generate = vi.fn(() => {
      throw Error("private runtime detail");
    });
  const generator: Generator = { kind: "throws-test", requestedModel: null, promptVersion: () => "test", generate };
  const result = await runGenerationJob({ db, clock, generator }, request("throws"));
  expect(result).toMatchObject({ ok: false, error: "sandbox_stop_unconfirmed" });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(await db.select().from(generationJobs))).not.toContain("private runtime detail");
});
