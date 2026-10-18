import { randomUUID } from "node:crypto";
import type { Actor } from "@siteoffer/core";
import { auditEvents, type Db, generationJobs, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { generationRetryPresentation, readGenerationRetries } from "./generation-retries";
import { seedCandidate, seedUser } from "./test-seed";

let db: Db, close: () => Promise<void>, ops: Actor, companyId: string, jobId: string;
const now = new Date("2026-10-19T00:00:00Z");
const feedback = { error: "fact_violation", rules: ["identity_mismatch"], fields: ["contact.phone.tel"] };
async function job(company = companyId) {
  const [row] = await db
    .insert(generationJobs)
    .values({
      companyId: company,
      idempotencyKey: randomUUID(),
      purpose: "demo_site",
      status: "running",
      attempts: 2,
      generator: "codex",
      promptVersion: "fixture",
      leaseUntil: new Date(now.getTime() + 120_000),
      output: { private: "PRIVATE_OUTPUT_SENTINEL" },
      error: "PRIVATE_PROVIDER_SENTINEL",
    })
    .returning();
  return row!.id;
}
async function event(
  id = jobId,
  attempt = 2,
  data: unknown = feedback,
  patch: Partial<typeof auditEvents.$inferInsert> = {},
) {
  await db.insert(auditEvents).values({
    actorKind: "system",
    action: "generation.attempt_started",
    targetType: "generation_job",
    targetId: id,
    createdAt: now,
    after: { attempt, retryFeedback: data },
    ...patch,
  });
}
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ actor: ops } = await seedUser(db, "ops"));
  companyId = (await seedCandidate(db)).company.id;
  jobId = await job();
}, 60_000);
afterEach(async () => {
  await close?.();
});

it("実際の試行の開始記録だけを読み、生成出力や生のエラーを返さない", async () => {
  await event();
  const result = await readGenerationRetries(db, ops, companyId, [jobId]);
  expect(result).toEqual({ ok: true, value: { [jobId]: { attempt: 2, feedback } } });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  expect(await db.select().from(auditEvents)).toHaveLength(1);
});

it("時刻が同じでも現在の試行に一致させ、過去・未来の記録で代用しない", async () => {
  await event(jobId, 1, { ...feedback, fields: ["company.name"] });
  await event();
  await event(jobId, 3, { ...feedback, fields: ["contact.email"] });
  let result = await readGenerationRetries(db, ops, companyId, [jobId]);
  expect(result.ok && result.value[jobId]?.feedback.fields).toEqual(["contact.phone.tel"]);
  await db.update(generationJobs).set({ attempts: 4 }).where(eq(generationJobs.id, jobId));
  result = await readGenerationRetries(db, ops, companyId, [jobId]);
  expect(result).toEqual({ ok: true, value: {} });
});

it("同じ会社・指定された生成だけを表示する", async () => {
  const other = (await seedCandidate(db)).company.id;
  const otherJob = await job(other);
  await event();
  await event(otherJob);
  const result = await readGenerationRetries(db, ops, companyId, [jobId, otherJob]);
  expect(result.ok && Object.keys(result.value)).toEqual([jobId]);
  expect(await readGenerationRetries(db, ops, companyId, [])).toEqual({ ok: true, value: {} });
});

it("対象種別・操作の種類が違う履歴を採用しない", async () => {
  await event(jobId, 2, feedback, { targetType: "company" });
  await event(jobId, 2, feedback, { action: "generation.failed" });
  expect(await readGenerationRetries(db, ops, companyId, [jobId])).toEqual({ ok: true, value: {} });
});

it("同じ試行の矛盾した記録を推測で選ばず、同一内容の重複はまとめる", async () => {
  await event();
  await event(jobId, 2, { ...feedback, fields: ["contact.email"] });
  const duplicate = await job();
  await event(duplicate);
  await event(duplicate);
  let result = await readGenerationRetries(db, ops, companyId, [jobId, duplicate]);
  expect(result.ok && Object.keys(result.value)).toEqual([duplicate]);
  await db.insert(auditEvents).values({
    actorKind: "system",
    action: "generation.attempt_started",
    targetType: "generation_job",
    targetId: duplicate,
    after: { attempt: 2 },
  });
  result = await readGenerationRetries(db, ops, companyId, [duplicate]);
  expect(result).toEqual({ ok: true, value: {} });
});

it("表示する規則・項目を限定し、不正な形式や初回の記録を採用しない", async () => {
  await event(jobId, 2, {
    ...feedback,
    message: "PRIVATE_FEEDBACK_SENTINEL",
    fields: ["contact.phone.tel", "PRIVATE_FIELD_SENTINEL"],
    rules: ["identity_mismatch", "PRIVATE_RULE_SENTINEL"],
  });
  const result = await readGenerationRetries(db, ops, companyId, [jobId]);
  expect(result).toEqual({ ok: true, value: { [jobId]: { attempt: 2, feedback } } });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  await db.update(generationJobs).set({ attempts: 1 }).where(eq(generationJobs.id, jobId));
  await event(jobId, 1);
  expect(await readGenerationRetries(db, ops, companyId, [jobId])).toEqual({ ok: true, value: {} });
});

it("営業・未認証・利用停止・存在しない運営を拒否する", async () => {
  const sales = await seedUser(db, "sales");
  for (const actor of [
    null,
    sales.actor,
    { kind: "ops", userId: sales.user.id },
    { kind: "ops", userId: randomUUID() },
  ] as (Actor | null)[])
    expect((await readGenerationRetries(db, actor, companyId, [jobId])).ok).toBe(false);
  if (ops.kind !== "ops") throw Error("fixture");
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, ops.userId));
  expect(await readGenerationRetries(db, ops, companyId, [jobId])).toMatchObject({ ok: false, error: "forbidden" });
});

it("不正なIDと20件を超える取得を拒否する", async () => {
  for (const [company, ids] of [
    ["invalid", [jobId]],
    [companyId, ["invalid"]],
    [companyId, Array.from({ length: 21 }, () => randomUUID())],
  ] as [string, string[]][])
    expect(await readGenerationRetries(db, ops, company, ids)).toMatchObject({ ok: false, error: "invalid_input" });
});

it("表示用の日本語へ変換し、古い試行の情報を表示しない", () => {
  const detail = {
    attempt: 2,
    feedback: {
      error: "fact_violation" as const,
      rules: ["identity_mismatch"],
      fields: ["contact.phone.tel", "companyInfo.rows.1.value"],
    },
  };
  expect(generationRetryPresentation(2, detail)).toEqual({
    title: "2回目の生成へ渡した確認事項",
    rules: ["会社名・連絡先を確認済みの値に合わせる"],
    fields: ["電話のリンク先", "会社情報の表"],
    companyInfo: true,
  });
  expect(generationRetryPresentation(3, detail)).toBeNull();
  expect(generationRetryPresentation(1, detail)).toBeNull();
  expect(generationRetryPresentation(2)).toBeNull();
});
