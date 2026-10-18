import { readFile } from "node:fs/promises";
import path from "node:path";
import { fixedClock } from "@siteoffer/core";
import { auditEvents, type Db, generationJobs } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CodexGenerator } from "../src/codex.ts";
import { runGenerationJob } from "../src/jobs.ts";
import { loadCodexFixture } from "../src/mock.ts";
import { NoopSandboxRunner } from "../src/sandbox/noop.ts";
import { fixtureInput } from "./helpers.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-19T00:00:00+09:00");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterEach(async () => {
  await close?.();
});

it("会社情報の検査結果を次の試行へ渡し、再検査に通った出力だけを保存する", async () => {
  const bad = structuredClone(loadCodexFixture("demo_site")) as { contact: { phone: { tel: string | null } } };
  bad.contact.phone.tel = "052-987-6543";
  const runner = new NoopSandboxRunner([
    { finalResponse: JSON.stringify(bad) },
    { finalResponse: JSON.stringify(loadCodexFixture("demo_site")) },
  ]);
  const generator = new CodexGenerator(runner);
  const input = fixtureInput(),
    before = structuredClone(input);
  const request = { idempotencyKey: "correct-company-contact", companyId: null, purpose: "demo_site" as const, input };
  const result = await runGenerationJob({ db, clock, generator, limits: { maxAttempts: 2 } }, request);
  expect(result.ok).toBe(true);
  expect(runner.calls).toHaveLength(2);
  expect(runner.calls[0]!.request.prompt).not.toContain("validation_retry.v1");
  expect(runner.calls[1]!.request.prompt).toContain('"contact.phone.tel"');
  expect(runner.calls[1]!.request.prompt).toContain('"identity_mismatch"');
  expect(runner.calls[1]!.request.prompt).not.toContain("052-987-6543");
  expect(input).toEqual(before);
  const [job] = await db.select().from(generationJobs);
  expect(job).toMatchObject({
    status: "succeeded",
    attempts: 2,
    errorCode: null,
    output: loadCodexFixture("demo_site"),
  });
  expect(job!.promptVersion).toContain("+validation_retry.v1#");
  const attempts = (await db.select().from(auditEvents)).filter((e) => e.action === "generation.attempt_started");
  expect(attempts[1]!.after).toMatchObject({
    attempt: 2,
    retryFeedback: { error: "fact_violation", fields: ["contact.phone.tel"] },
  });
  expect((await runGenerationJob({ db, clock, generator }, request)).ok).toBe(true);
  expect(runner.calls).toHaveLength(2);
});

it("途中の実行エラーを指示にせず、直近の検査結果と同じ確認情報を維持する", async () => {
  const runner = new NoopSandboxRunner([
    { finalResponse: "PRIVATE_INVALID_JSON" },
    { fail: "sandbox_error", message: "PRIVATE_PROVIDER_INSTRUCTION" },
    { finalResponse: JSON.stringify(loadCodexFixture("faq")) },
  ]);
  const facts: string[] = [];
  const generator = new CodexGenerator({
    kind: "noop",
    run: async (spec) => {
      facts.push(await readFile(path.join(spec.workDir, "input", "facts.json"), "utf8"));
      return runner.run(spec);
    },
  });
  const result = await runGenerationJob(
    { db, clock, generator, limits: { maxAttempts: 3 } },
    { idempotencyKey: "keep-validation", companyId: null, purpose: "faq", input: fixtureInput() },
  );
  expect(result.ok).toBe(true);
  expect(runner.calls).toHaveLength(3);
  expect(new Set(facts).size).toBe(1);
  for (const call of runner.calls.slice(1)) {
    expect(call.request.prompt).toContain('"invalid_json"');
    expect(call.request.prompt).not.toContain("PRIVATE_INVALID_JSON");
    expect(call.request.prompt).not.toContain("PRIVATE_PROVIDER_INSTRUCTION");
  }
});

it("実行場所のエラー文を検査結果として再送しない", async () => {
  const runner = new NoopSandboxRunner([
    { fail: "sandbox_error", message: "PRIVATE_PROVIDER_INSTRUCTION" },
    { finalResponse: JSON.stringify(loadCodexFixture("faq")) },
  ]);
  const result = await runGenerationJob(
    { db, clock, generator: new CodexGenerator(runner) },
    { idempotencyKey: "transport-only", companyId: null, purpose: "faq", input: fixtureInput() },
  );
  expect(result.ok).toBe(true);
  expect(runner.calls[1]!.request.prompt).not.toContain("validation_retry.v1");
  expect(runner.calls[1]!.request.prompt).not.toContain("PRIVATE_PROVIDER_INSTRUCTION");
});

it("修正しても検査に通らない場合は既存の上限で止まり、出力を採用しない", async () => {
  const runner = new NoopSandboxRunner([{ finalResponse: "{}" }]);
  const result = await runGenerationJob(
    { db, clock, generator: new CodexGenerator(runner), limits: { maxAttempts: 2 } },
    { idempotencyKey: "bounded-validation", companyId: null, purpose: "demo_site", input: fixtureInput() },
  );
  expect(result.ok).toBe(false);
  expect(runner.calls).toHaveLength(2);
  const [job] = await db.select().from(generationJobs);
  expect(job).toMatchObject({
    status: "failed",
    attempts: 2,
    errorCode: "schema_violation",
    output: null,
    outputRef: null,
  });
});

it("中断した処理では修正生成を追加で呼ばない", async () => {
  const runner = new NoopSandboxRunner([
    { fail: "aborted" },
    { finalResponse: JSON.stringify(loadCodexFixture("faq")) },
  ]);
  const result = await runGenerationJob(
    { db, clock, generator: new CodexGenerator(runner), limits: { maxAttempts: 3 } },
    { idempotencyKey: "abort-feedback", companyId: null, purpose: "faq", input: fixtureInput() },
  );
  expect(result.ok).toBe(false);
  expect(runner.calls).toHaveLength(1);
});
