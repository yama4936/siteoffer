import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFixtureCollector,
  createGenerationEvaluationGenerator,
  createPythonRunner,
  defaultAuditOptions,
} from "@siteoffer/audit";
import { fixedClock } from "@siteoffer/core";
import type { Db } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { FixtureProvider, MockSearchProvider } from "@siteoffer/discovery";
import { type Generator, loadCodexFixture, MockGenerator } from "@siteoffer/generation";
import type { GenerationInput } from "@siteoffer/schemas";
import type { DemoCheckSummary } from "../src/content.ts";
import { silentLogger, type WorkerDeps } from "../src/deps.ts";
import type { GenerationInputBuilder } from "../src/input.ts";
import { DEFAULT_POLICIES, type StepKind, type StepPolicy } from "../src/queues.ts";
import { createWorkerRuntime, InMemoryQueue } from "../src/runtime.ts";
import type { SiteBuilder } from "../src/site-builder.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const COLLECTED_FIXTURE = path.join(REPO_ROOT, "fixtures/audit/collected/kakuu-koumuten.collected.json");
const EVALUATION_FIXTURE = path.join(REPO_ROOT, "fixtures/audit/evaluations/kakuu-koumuten.evaluation.json");

/** 診断の固定応答（fixtures/audit）を、生成の evaluationSchema（strict・省略なし）の形にする */
export function generationShapedEvaluation() {
  const ev = JSON.parse(readFileSync(EVALUATION_FIXTURE, "utf8")) as Record<string, unknown>;
  delete ev._fixture;
  return { ...ev, fatal_reason: null, collected_at: null, evaluated_at: null, summary: {} };
}

/** 生成の入力に fixtures/codex/input.json を使う（モックの固定応答が参照する事実キーと揃える） */
export const fixtureInputBuilder: GenerationInputBuilder = async () => loadCodexFixture("input") as GenerationInput;

/** Astroを動かさないビルド（呼ばれた回数を数える）。dist の代わりに空のディレクトリを作る */
export function fakeSiteBuilder(outcome?: Partial<{ ok: boolean; retryable: boolean; hang: boolean }>) {
  const calls: string[] = [];
  const check: DemoCheckSummary = { ok: true, pages: ["index.html"], counts: {}, errors: [], mobile: "skipped" };
  const build: SiteBuilder["buildDemo"] = async ({ workDir }) => {
    calls.push(workDir);
    if (outcome?.hang) return new Promise(() => {});
    if (outcome?.ok === false) {
      return {
        ok: false,
        reason: "astro-build-failed",
        message: "模擬的なビルド失敗",
        retryable: outcome.retryable ?? true,
      };
    }
    const distDir = path.join(workDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, "index.html"), "<!doctype html><title>fake</title>");
    return { ok: true, distDir, check };
  };
  const builder: SiteBuilder = { buildDemo: build, buildDelivery: build };
  return { builder, calls };
}

export interface TestEnv {
  db: Db;
  clock: ReturnType<typeof fixedClock>;
  queue: InMemoryQueue;
  deps: WorkerDeps;
  runtime: ReturnType<typeof createWorkerRuntime>;
  dir: string;
  generator: MockGenerator;
  cleanup: () => Promise<void>;
}

/**
 * PGlite・フィクスチャの取得元・モック生成器・取得済みの収集結果で、ワーカーの部品を組み立てる。
 * threshold は評価設定（config/site-evaluation.json の写し）の提案閾値。テストの中だけで設定する（未決の値を決めたわけではない）。
 */
export async function setupEnv(
  options: {
    threshold?: number | null;
    siteBuilder?: SiteBuilder;
    generator?: MockGenerator;
    generationMaxAttempts?: number;
    policies?: Partial<Record<StepKind, Partial<StepPolicy>>>;
    buildInput?: GenerationInputBuilder;
  } = {},
): Promise<TestEnv> {
  const { db, close } = await createTestDb();
  const dir = await mkdtemp(path.join(os.tmpdir(), "siteoffer-worker-"));
  const base = defaultAuditOptions({}, { paths: { repoRoot: REPO_ROOT }, screenshot: false });
  const cfg = JSON.parse(await readFile(base.paths.configPath, "utf8")) as { proposal: Record<string, unknown> };
  cfg.proposal.threshold = options.threshold ?? null;
  const configPath = path.join(dir, "site-evaluation.json");
  await writeFile(configPath, JSON.stringify(cfg));
  const auditOptions = { ...base, paths: { ...base.paths, configPath, artifactRoot: path.join(dir, "audits") } };

  const clock = fixedClock("2026-10-14T06:00:00Z");
  const queue = new InMemoryQueue();
  const generator = options.generator ?? new MockGenerator({ overrides: { evaluation: generationShapedEvaluation() } });
  const limits = { maxAttempts: options.generationMaxAttempts ?? 1 };
  const policies = { ...DEFAULT_POLICIES };
  for (const [k, v] of Object.entries(options.policies ?? {}) as [StepKind, Partial<StepPolicy>][]) {
    policies[k] = { ...policies[k], ...v };
  }
  const fixture = new FixtureProvider();
  const deps: WorkerDeps = {
    db,
    clock,
    queue,
    logger: silentLogger,
    discovery: { providers: { [fixture.name]: fixture }, search: new MockSearchProvider() },
    audit: {
      collector: createFixtureCollector(COLLECTED_FIXTURE),
      generator: createGenerationEvaluationGenerator({ db, clock, generator: generator as Generator, limits }),
      runner: createPythonRunner(),
      options: auditOptions,
    },
    generation: { generator, limits },
    buildGenerationInput: options.buildInput ?? fixtureInputBuilder,
    siteBuilder: options.siteBuilder ?? fakeSiteBuilder().builder,
    demoArtifactRoot: path.join(dir, "demos"),
    deliveryArtifactRoot: path.join(dir, "deliveries"),
    policies,
    discoveryStaleAfterMs: 60 * 60 * 1000,
  };
  return {
    db,
    clock,
    queue,
    deps,
    runtime: createWorkerRuntime(deps),
    dir,
    generator,
    cleanup: async () => {
      await close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 収集条件：架空企業「株式会社あおば印刷」（公式サイトが確認済みになる）1社だけ */
export const ONE_COMPANY_CRITERIA = { keywords: ["あおば印刷"] };
