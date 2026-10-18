import { fixedClock } from "@siteoffer/core";
import { auditEvents, type Db, generationJobs } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexGenerator } from "../src/codex.ts";
import { runGenerationJob } from "../src/jobs.ts";
import { ConcurrencyLimiter } from "../src/limiter.ts";
import { MockGenerator } from "../src/mock.ts";
import { NoopSandboxRunner } from "../src/sandbox/noop.ts";
import { generationPurposes } from "../src/schemas.ts";
import type { Generator, GeneratorResult } from "../src/types.ts";
import { fixtureInput } from "./helpers.ts";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-14T10:00:00+09:00");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

describe("生成ジョブ（モック）", () => {
  it("全用途が通り、記録の取れない項目はnullになる", async () => {
    for (const purpose of generationPurposes) {
      const r = await runGenerationJob(
        { db, clock, generator: new MockGenerator() },
        { idempotencyKey: `k-${purpose}`, companyId: null, purpose, input: fixtureInput() },
      );
      expect(r.ok, purpose).toBe(true);
      if (!r.ok) continue;
      expect(r.value.reused).toBe(false);
      expect(r.value.output).not.toBeNull();
      expect(r.value.job).toMatchObject({
        status: "succeeded",
        attempts: 1,
        generator: "mock",
        requestedModel: null,
        responseModel: null,
        sdkVersion: null,
        cliVersion: null,
        threadId: null,
        requestId: null,
        usage: null,
        errorCode: null,
      });
      expect(r.value.job.promptVersion).toMatch(new RegExp(`\\+${purpose}\\.v\\d+#`));
      expect(r.value.job.outputRef).toMatchObject({ storage: "generation_jobs.output" });
      expect(r.value.job.inputRef).toMatchObject({ needsReviewFactKeys: ["claim.award", "claim.price"] });
    }
  });

  it("同じ冪等キーでは二重に実行せず、既存のジョブを返す", async () => {
    const gen = new MockGenerator();
    const req = { idempotencyKey: "same", companyId: null, purpose: "faq" as const, input: fixtureInput() };
    const a = await runGenerationJob({ db, clock, generator: gen }, req);
    const b = await runGenerationJob({ db, clock, generator: gen }, req);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.reused).toBe(true);
    expect(b.value.job.id).toBe(a.value.job.id);
    expect(b.value.output).toEqual(a.value.output);
    expect(gen.calls).toHaveLength(1);
    expect(await db.select().from(generationJobs)).toHaveLength(1);
  });

  it("スキーマ違反は再試行上限まで試して失敗として記録する", async () => {
    const gen = new MockGenerator({ overrides: { faq: { items: [] } } });
    const r = await runGenerationJob(
      { db, clock, generator: gen, limits: { maxAttempts: 2 } },
      { idempotencyKey: "bad", companyId: null, purpose: "faq", input: fixtureInput() },
    );
    expect(r).toMatchObject({ ok: false, error: "generation_failed" });
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.idempotencyKey, "bad"));
    expect(job).toMatchObject({ status: "failed", attempts: 2, errorCode: "schema_violation", output: null });
    expect(gen.calls).toHaveLength(2);
  });

  it("要確認の印が残った出力は事実違反で失敗する", async () => {
    const gen = new MockGenerator({
      overrides: { faq: { items: [{ question: "Q", answer: "要確認", category: "other", factRefs: [] }] } },
    });
    const r = await runGenerationJob(
      { db, clock, generator: gen, limits: { maxAttempts: 1 } },
      { idempotencyKey: "marker", companyId: null, purpose: "faq", input: fixtureInput() },
    );
    expect(r.ok).toBe(false);
    const [job] = await db.select().from(generationJobs);
    expect(job!.errorCode).toBe("fact_violation");
  });

  it("不正な入力はジョブを作らずに返す", async () => {
    const input = { ...fixtureInput(), facts: [{ key: "x" }] } as never;
    const r = await runGenerationJob(
      { db, clock, generator: new MockGenerator() },
      { idempotencyKey: "invalid", companyId: null, purpose: "faq", input },
    );
    expect(r).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await db.select().from(generationJobs)).toHaveLength(0);
  });

  it("状態の変化を操作履歴に残す", async () => {
    await runGenerationJob(
      { db, clock, generator: new MockGenerator() },
      { idempotencyKey: "ev", companyId: null, purpose: "faq", input: fixtureInput() },
    );
    const actions = (await db.select().from(auditEvents)).map((e) => e.action);
    expect(actions).toEqual(["generation.job_created", "generation.attempt_started", "generation.succeeded"]);
  });
});

describe("生成ジョブ（Codex生成器＋NoopSandboxRunner）", () => {
  it("実行場所が失敗し続けると再試行上限で止まり、最後のスレッドIDを記録する", async () => {
    const runner = new NoopSandboxRunner([
      { ok: false, threadId: "t-1", error: "boom" },
      { ok: false, threadId: "t-2", error: "boom" },
      { ok: false, threadId: "t-3", error: "boom" },
      { ok: false, threadId: "t-4", error: "boom" },
    ]);
    const r = await runGenerationJob(
      { db, clock, generator: new CodexGenerator(runner), limits: { maxAttempts: 3 } },
      { idempotencyKey: "retry", companyId: null, purpose: "proposal_text", input: fixtureInput() },
    );
    expect(r.ok).toBe(false);
    expect(runner.calls).toHaveLength(3);
    const [job] = await db.select().from(generationJobs);
    expect(job).toMatchObject({ status: "failed", attempts: 3, errorCode: "sandbox_error", threadId: "t-3" });
    // 1ジョブ1スレッド：試行ごとに新しい作業ディレクトリ
    expect(new Set(runner.calls.map((c) => c.workDir)).size).toBe(3);
  });

  it("2回目で成功すれば成功として記録し、試行回数を残す", async () => {
    const { loadCodexFixture } = await import("../src/mock.ts");
    const runner = new NoopSandboxRunner([
      { fail: "timeout" },
      {
        threadId: "t-ok",
        finalResponse: JSON.stringify(loadCodexFixture("proposal_text")),
        usage: { input_tokens: 3 },
      },
    ]);
    const r = await runGenerationJob(
      { db, clock, generator: new CodexGenerator(runner, { model: "m-1" }) },
      { idempotencyKey: "retry-ok", companyId: null, purpose: "proposal_text", input: fixtureInput() },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.job).toMatchObject({
      status: "succeeded",
      attempts: 2,
      threadId: "t-ok",
      requestedModel: "m-1",
      responseModel: null,
      usage: { input_tokens: 3 },
    });
  });
});

describe("タイムアウトと同時実行数", () => {
  const hanging: Generator = {
    kind: "hang",
    requestedModel: null,
    promptVersion: () => "test",
    generate: () => new Promise<GeneratorResult<never>>(() => {}),
  };

  it("応答も停止確認もない試行は要確認にして再試行しない", async () => {
    const r = await runGenerationJob(
      { db, clock, generator: hanging, limits: { timeoutMs: 20, stopTimeoutMs: 10, maxAttempts: 2 } },
      { idempotencyKey: "hang", companyId: null, purpose: "faq", input: fixtureInput() },
    );
    expect(r.ok).toBe(false);
    const [job] = await db.select().from(generationJobs);
    expect(job).toMatchObject({ status: "needs_review", attempts: 1, errorCode: "sandbox_stop_unconfirmed" });
  });

  it("同時実行数の上限を超えて生成器を呼ばない", async () => {
    let active = 0;
    let peak = 0;
    const slow: Generator = {
      kind: "slow",
      requestedModel: null,
      promptVersion: () => "test",
      async generate(req) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return new MockGenerator().generate(req);
      },
    };
    const limiter = new ConcurrencyLimiter(2);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        runGenerationJob(
          { db, clock, generator: slow, limiter },
          { idempotencyKey: `c-${i}`, companyId: null, purpose: "faq", input: fixtureInput() },
        ),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
