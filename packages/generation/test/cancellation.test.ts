import { fixedClock } from "@siteoffer/core";
import { auditEvents, generationJobs } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGenerationJob } from "../src/jobs.ts";
import { ConcurrencyLimiter } from "../src/limiter.ts";
import { MockGenerator } from "../src/mock.ts";
import type { Generator, GeneratorResult } from "../src/types.ts";
import { fixtureInput } from "./helpers.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("親の中断と生成履歴", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  const clock = fixedClock("2026-10-16T10:00:00Z");
  beforeEach(async () => {
    testDb = await createTestDb();
  });
  afterEach(async () => {
    await testDb.close();
  });
  const req = (signal: AbortSignal) => ({
    idempotencyKey: "cancel",
    companyId: null,
    purpose: "faq" as const,
    input: fixtureInput(),
    signal,
  });
  it("開始前の中断は生成器を呼ばず、試行0回で記録する", async () => {
    const { db } = testDb,
      generator = new MockGenerator();
    const r = await runGenerationJob({ db, clock, generator }, req(AbortSignal.abort("private reason")));
    expect(r.ok).toBe(false);
    expect(generator.calls).toHaveLength(0);
    expect(await db.select().from(generationJobs)).toMatchObject([
      { status: "failed", attempts: 0, errorCode: "aborted", output: null },
    ]);
    const events = await db.select().from(auditEvents);
    expect(events.map((e) => e.action)).toEqual(["generation.job_created", "generation.failed"]);
    expect(JSON.stringify(events)).not.toContain("private reason");
  });
  it("枠待ちで中断したジョブは、先行ジョブの完了を待たずに閉じる", async () => {
    const { db } = testDb,
      limiter = new ConcurrencyLimiter(1),
      generator = new MockGenerator();
    const gate = deferred<void>(),
      entered = deferred<void>();
    const first = limiter.run(async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    const result = runGenerationJob({ db, clock, generator, limiter }, req(controller.signal));
    try {
      await expect.poll(async () => (await db.select().from(generationJobs)).length).toBe(1);
      controller.abort();
      expect((await result).ok).toBe(false);
      expect(limiter.active).toBe(1);
      expect(generator.calls).toHaveLength(0);
      expect(await db.select().from(generationJobs)).toMatchObject([
        { status: "failed", attempts: 0, errorCode: "aborted" },
      ]);
    } finally {
      gate.resolve();
      await first;
    }
    expect(limiter.active).toBe(0);
    expect(await limiter.run(async () => "next")).toBe("next");
  });
  it("実行中の中断を生成器へ伝え、非協調の遅い成功も保存・再試行しない", async () => {
    const { db } = testDb,
      controller = new AbortController();
    const entered = deferred<AbortSignal>(),
      late = deferred<GeneratorResult<never>>();
    let calls = 0;
    const generator: Generator = {
      kind: "cancel-test",
      requestedModel: null,
      promptVersion: () => "test",
      generate: (r) => {
        calls++;
        entered.resolve(r.signal!);
        return late.promise;
      },
    };
    const result = runGenerationJob(
      { db, clock, generator, limits: { maxAttempts: 3, timeoutMs: 60000 } },
      req(controller.signal),
    );
    const signal = await entered.promise;
    controller.abort();
    expect(signal.aborted).toBe(true);
    late.resolve({
      ok: true,
      output: { invalid: true } as never,
      record: {
        generator: "cancel-test",
        requestedModel: null,
        responseModel: null,
        sdkVersion: null,
        cliVersion: null,
        promptVersion: "test",
        threadId: null,
        requestId: null,
        usage: null,
      },
    });
    await late.promise;
    expect((await result).ok).toBe(false);
    expect(await db.select().from(generationJobs)).toMatchObject([
      { status: "failed", errorCode: "aborted", attempts: 1, output: null },
    ]);
    expect(calls).toBe(1);
    expect((await db.select().from(auditEvents)).filter((e) => e.action === "generation.succeeded")).toHaveLength(0);
    const same = await runGenerationJob({ db, clock, generator }, req(new AbortController().signal));
    expect(same.ok && same.value).toMatchObject({ reused: true, output: null, job: { errorCode: "aborted" } });
    expect(calls).toBe(1);
  });
  it("終了しない生成器は停止確認待ちにし、同じ試行を再実行しない", async () => {
    const { db } = testDb,
      signals: AbortSignal[] = [];
    const generator: Generator = {
      kind: "timeout-test",
      requestedModel: null,
      promptVersion: () => "test",
      generate: (r) => {
        signals.push(r.signal!);
        return new Promise<GeneratorResult<never>>(() => {});
      },
    };
    const r = await runGenerationJob(
      { db, clock, generator, limits: { maxAttempts: 2, timeoutMs: 10, stopTimeoutMs: 10 } },
      req(new AbortController().signal),
    );
    expect(r.ok).toBe(false);
    expect(signals).toHaveLength(1);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(await db.select().from(generationJobs)).toMatchObject([
      { status: "needs_review", errorCode: "sandbox_stop_unconfirmed", attempts: 1, leaseUntil: null, output: null },
    ]);
  });
});

it("解放枠を待機者に予約し、割り込みと待機キャンセルでも上限を維持する", async () => {
  const limiter = new ConcurrencyLimiter(1),
    gate = deferred<void>(),
    order: string[] = [];
  const first = limiter.run(() => gate.promise);
  const cancelled = new AbortController();
  const wait = limiter
    .run(async () => {
      order.push("cancelled");
    }, cancelled.signal)
    .catch(() => "aborted");
  const secondGate = deferred<void>();
  const second = limiter.run(async () => {
    order.push("second");
    expect(limiter.active).toBe(1);
    await secondGate.promise;
  });
  cancelled.abort();
  expect(await wait).toBe("aborted");
  // 同じPromiseの後続反応は、枠解放の後・待機者の再開前に割り込む。
  const third = gate.promise.then(() =>
    limiter.run(async () => {
      order.push("third");
      expect(limiter.active).toBe(1);
    }),
  );
  gate.resolve();
  await first;
  await Promise.resolve();
  expect(order).toEqual(["second"]);
  secondGate.resolve();
  await Promise.all([second, third]);
  expect(order).toEqual(["second", "third"]);
  expect(limiter.active).toBe(0);
});
