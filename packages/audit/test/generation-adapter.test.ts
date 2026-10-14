/**
 * 診断（T7）の採点を、T5の生成ジョブ（MockGenerator。Codexは呼ばない）につないだ場合の確認。
 * モックでの成功は実生成の成功ではない（24.3）。
 */
import { type Actor, fixedClock } from "@siteoffer/core";
import { type Db, generationJobs, siteAudits } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { MockGenerator } from "@siteoffer/generation";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureCollector } from "../src/collect.ts";
import type { AuditOptions } from "../src/config.ts";
import { createGenerationEvaluationGenerator, evaluationIdempotencyKey } from "../src/generation-adapter.ts";
import type { EvaluationGeneratorInput } from "../src/generator.ts";
import { createPythonRunner } from "../src/python.ts";
import { runSiteAudit } from "../src/service.ts";
import { COLLECTED_FIXTURE, evaluationFixture, seedWebsite, tempOptions } from "./helpers.ts";

const actor: Actor = { kind: "system", job: "site-audit-test" };

let db: Db;
let close: () => Promise<void>;
let options: AuditOptions;
let cleanup: () => Promise<void>;
const clock = fixedClock("2026-10-14T06:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ options, cleanup } = await tempOptions());
});
afterEach(async () => {
  await close();
  await cleanup();
});

/** 診断の固定応答（fixtures/audit）を、T5の evaluationSchema（strict・省略なし）の形にする */
function generationShapedEvaluation() {
  const ev = evaluationFixture() as Record<string, unknown>;
  delete ev._fixture;
  return { ...ev, fatal_reason: null, collected_at: null, evaluated_at: null, summary: {} };
}

function auditDeps(generator: MockGenerator, maxAttempts = 3) {
  return {
    collector: createFixtureCollector(COLLECTED_FIXTURE),
    generator: createGenerationEvaluationGenerator({ db, clock, generator, limits: { maxAttempts } }),
    runner: createPythonRunner(),
    options,
  };
}

describe("生成ジョブにつないだ採点", () => {
  it("runSiteAudit が生成ジョブを1件記録して評価済みになり、診断にジョブIDを結び付ける", async () => {
    const { company, site } = await seedWebsite(db);
    const gen = new MockGenerator({ overrides: { evaluation: generationShapedEvaluation() } });
    const r = await runSiteAudit(db, clock, auditDeps(gen), { websiteId: site.id, actor });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.status).toBe("evaluated");
    expect(r.value.decision).toBe("hold");

    const jobs = await db.select().from(generationJobs);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job).toMatchObject({
      purpose: "evaluation",
      status: "succeeded",
      generator: "mock",
      companyId: company.id,
      idempotencyKey: evaluationIdempotencyKey(r.value.auditId),
      responseModel: null,
    });
    expect(job.inputRef).toMatchObject({
      externalDataIds: ["collected"],
      attachments: ["rubric.md", "output-format.md"],
    });

    const [audit] = await db.select().from(siteAudits).where(eq(siteAudits.id, r.value.auditId));
    expect(audit).toMatchObject({ status: "evaluated", generationJobId: job.id, evaluatorModel: null });
    expect(Number(audit!.totalScore)).toBe(41);

    // 生成器に渡った入力：観測は外部データ、評価指標・出力形式は添付
    expect(gen.calls).toHaveLength(1);
    const call = gen.calls[0]!;
    expect(call.purpose).toBe("evaluation");
    expect(call.input.externalData[0]!.content).toContain("kakuu-koumuten.example");
    expect(call.input.attachments.map((a) => a.path)).toEqual([
      `${options.paths.evaluationSkillDir}/references/rubric.md`,
      `${options.paths.evaluationSkillDir}/references/output-format.md`,
    ]);
  });

  it("生成ジョブが失敗したら診断は failed になり、失敗したジョブが記録に残る", async () => {
    const { site } = await seedWebsite(db);
    const gen = new MockGenerator({ overrides: { evaluation: { status: "evaluated" } } });
    const r = await runSiteAudit(db, clock, auditDeps(gen, 1), { websiteId: site.id, actor });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.status).toBe("failed");
    expect(r.value.failureReason).toContain("採点の生成に失敗した");
    const jobs = await db.select().from(generationJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "failed", errorCode: "schema_violation" });
  });
});

describe("アダプタ単体", () => {
  const input = (auditId: string, screenshotPaths: string[]): EvaluationGeneratorInput => ({
    auditId,
    targetUrl: "https://kakuu-koumuten.example/",
    collected: { target_url: "https://kakuu-koumuten.example/", collected_at: "2026-10-14T05:33:52Z" },
    collectedPath: "/tmp/collected.json",
    screenshotPaths,
    rubric: "rubric",
    outputFormat: "format",
    rubricPath: "/skill/references/rubric.md",
    outputFormatPath: "/skill/references/output-format.md",
    prompt: "（使わない）",
  });

  it("スクリーンショットは画像の添付として渡し、ファイル名を作業ディレクトリで使える形にする", async () => {
    const gen = new MockGenerator();
    const generator = createGenerationEvaluationGenerator({ db, clock, generator: gen });
    const r = await generator.generate(
      input(crypto.randomUUID(), ["/art/x/desktop shot.png", "/art/y/desktop shot.png"]),
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.value.model).toBeNull();
    expect(r.value.generationJobId).toBeTypeOf("string");

    const att = gen.calls[0]!.input.attachments;
    expect(att.filter((a) => a.kind === "image")).toEqual([
      {
        name: "desktop_shot.png",
        path: "/art/x/desktop shot.png",
        kind: "image",
        imagePolicy: expect.objectContaining({
          sourceType: "original_site",
          rightsStatus: "unknown",
          allowedUses: ["analysis_only"],
        }),
      },
      {
        name: "screenshot-2-desktop_shot.png",
        path: "/art/y/desktop shot.png",
        kind: "image",
        imagePolicy: expect.objectContaining({
          sourceType: "original_site",
          rightsStatus: "unknown",
          allowedUses: ["analysis_only"],
        }),
      },
    ]);
    expect(gen.calls[0]!.input.context).toMatchObject({
      task: "site_evaluation",
      screenshots: ["desktop_shot.png", "screenshot-2-desktop_shot.png"],
    });
    expect(gen.calls[0]!.input.externalData[0]).toMatchObject({ id: "collected", fetchedAt: "2026-10-14T05:33:52Z" });
  });

  it("同じ診断IDの採点は二重に実行しない（既存のジョブを返す）", async () => {
    const gen = new MockGenerator();
    const generator = createGenerationEvaluationGenerator({ db, clock, generator: gen });
    const id = crypto.randomUUID();
    const a = await generator.generate(input(id, []));
    const b = await generator.generate(input(id, []));
    if (!a.ok || !b.ok) throw new Error("失敗");
    expect(b.value.generationJobId).toBe(a.value.generationJobId);
    expect(gen.calls).toHaveLength(1);
    expect(await db.select().from(generationJobs)).toHaveLength(1);
  });
});
