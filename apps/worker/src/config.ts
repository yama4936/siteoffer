import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuditOptions,
  createFixtureCollector,
  createGenerationEvaluationGenerator,
  createPythonCollector,
  createPythonRunner,
  defaultAuditOptions,
} from "@siteoffer/audit";
import { type Clock, err, ok, type Result } from "@siteoffer/core";
import type { Db } from "@siteoffer/db";
import {
  type DiscoveryProvider,
  FixtureProvider,
  MockSearchProvider,
  NtaCorporateNumberProvider,
} from "@siteoffer/discovery";
import {
  CodexGenerator,
  ConcurrencyLimiter,
  DEFAULT_GENERATION_LIMITS,
  DockerSandboxRunner,
  type Generator,
  MockGenerator,
} from "@siteoffer/generation";
import type { JobQueue, Logger, WorkerDeps } from "./deps.ts";
import { defaultGenerationInputBuilder } from "./input.ts";
import { DEFAULT_POLICIES, DEFAULT_SCHEDULES, type StepKind, type StepPolicy } from "./queues.ts";
import { createAstroSiteBuilder } from "./site-builder.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export type GeneratorConfig =
  | { kind: "mock" }
  | { kind: "codex"; image: string; network: string; codexAuthFile: string; model: string | null; user?: string };

export type DiscoveryProviderName = "fixture" | "nta";

export interface WorkerConfig {
  /** pg-boss とDBの接続先。値はログに出さない */
  databaseUrl: string | null;
  generator: GeneratorConfig;
  discoveryProviders: DiscoveryProviderName[];
  auditCollector: { kind: "fixture"; collectedPath: string } | { kind: "python" };
  auditOptions: AuditOptions;
  demoArtifactRoot: string;
  policies: Record<StepKind, StepPolicy>;
  schedules: { expireAssignments: string; recoverDiscovery: string };
  discoveryStaleAfterMs: number;
  /** キューごとの同時実行数（このプロセス内） */
  concurrency: Record<StepKind, number>;
}

export type ConfigError = "invalid_config";

/**
 * 環境変数から設定を作る。既定はモック生成器・フィクスチャの取得元・取得済みの収集結果で、外部へアクセスしない。
 * 実Codex・実国税庁API・collect.py（実サイトの取得）は、明示の設定と必要な環境変数が揃ったときだけ選ぶ。
 * 揃っていなければモックへ黙って戻さず、設定エラーにする（実在企業にモックの出力を作らないため）。
 */
export function resolveWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): Result<WorkerConfig, ConfigError> {
  const problems: string[] = [];
  const v = (k: string) => env[k]?.trim() || undefined;

  let generator: GeneratorConfig = { kind: "mock" };
  const genKind = v("SITEOFFER_GENERATOR") ?? "mock";
  if (genKind === "codex") {
    const image = v("SITEOFFER_CODEX_IMAGE");
    const network = v("SITEOFFER_CODEX_NETWORK");
    const codexAuthFile = v("SITEOFFER_CODEX_AUTH_FILE");
    const missing = [
      !image && "SITEOFFER_CODEX_IMAGE",
      !network && "SITEOFFER_CODEX_NETWORK",
      !codexAuthFile && "SITEOFFER_CODEX_AUTH_FILE",
    ].filter(Boolean);
    if (missing.length) problems.push(`SITEOFFER_GENERATOR=codex には ${missing.join("・")} が必要`);
    else
      generator = {
        kind: "codex",
        image: image!,
        network: network!,
        codexAuthFile: codexAuthFile!,
        model: v("SITEOFFER_CODEX_MODEL") ?? null,
        user: v("SITEOFFER_CODEX_USER"),
      };
  } else if (genKind !== "mock") {
    problems.push(`SITEOFFER_GENERATOR は mock か codex（${genKind}）`);
  }

  const discoveryProviders: DiscoveryProviderName[] = [];
  for (const name of (v("SITEOFFER_DISCOVERY_PROVIDERS") ?? "fixture").split(",").map((s) => s.trim())) {
    if (name === "fixture") discoveryProviders.push("fixture");
    else if (name === "nta") {
      if (!v("NTA_APPLICATION_ID")) problems.push("取得元 nta には環境変数 NTA_APPLICATION_ID が必要");
      else discoveryProviders.push("nta");
    } else if (name) problems.push(`未知の取得元：${name}`);
  }

  const collectorKind = v("SITEOFFER_AUDIT_COLLECTOR") ?? "fixture";
  let auditCollector: WorkerConfig["auditCollector"];
  if (collectorKind === "python") auditCollector = { kind: "python" };
  else {
    if (collectorKind !== "fixture")
      problems.push(`SITEOFFER_AUDIT_COLLECTOR は fixture か python（${collectorKind}）`);
    auditCollector = {
      kind: "fixture",
      collectedPath:
        v("SITEOFFER_AUDIT_COLLECTED_FIXTURE") ??
        path.join(REPO_ROOT, "fixtures/audit/collected/kakuu-koumuten.collected.json"),
    };
  }

  const staleMinutes = Number(v("SITEOFFER_DISCOVERY_STALE_MINUTES") ?? 60);
  if (!Number.isFinite(staleMinutes) || staleMinutes < 1) problems.push("SITEOFFER_DISCOVERY_STALE_MINUTES が不正");

  if (problems.length) return err("invalid_config", problems.join("。"));
  return ok({
    databaseUrl: v("DATABASE_URL") ?? null,
    generator,
    discoveryProviders,
    auditCollector,
    auditOptions: defaultAuditOptions(env, { paths: { repoRoot: REPO_ROOT } }),
    demoArtifactRoot: v("SITEOFFER_DEMO_ARTIFACT_DIR") ?? path.join(REPO_ROOT, "reports/app/demos"),
    policies: DEFAULT_POLICIES,
    schedules: { ...DEFAULT_SCHEDULES },
    discoveryStaleAfterMs: staleMinutes * 60 * 1000,
    concurrency: { discovery: 1, audit: 2, proposal: DEFAULT_GENERATION_LIMITS.maxConcurrent },
  });
}

export function createGenerator(config: GeneratorConfig, env: NodeJS.ProcessEnv = process.env): Generator {
  if (config.kind === "mock") return new MockGenerator();
  const runner = new DockerSandboxRunner(
    {
      image: config.image,
      network: config.network,
      codexAuthFile: config.codexAuthFile,
      ...(config.user ? { user: config.user } : {}),
    },
    env,
  );
  return new CodexGenerator(runner, { model: config.model });
}

/** 設定から処理の部品を組み立てる */
export function buildWorkerDeps(
  config: WorkerConfig,
  base: { db: Db; clock: Clock; queue: JobQueue; logger: Logger },
): WorkerDeps {
  const generator = createGenerator(config.generator);
  const limiter = new ConcurrencyLimiter(DEFAULT_GENERATION_LIMITS.maxConcurrent);
  const providers: Record<string, DiscoveryProvider> = {};
  for (const name of config.discoveryProviders) {
    const p = name === "fixture" ? new FixtureProvider() : new NtaCorporateNumberProvider();
    providers[p.name] = p;
  }
  const runner = createPythonRunner(config.auditOptions.pythonBin);
  const collector =
    config.auditCollector.kind === "python"
      ? createPythonCollector(runner, config.auditOptions)
      : createFixtureCollector(config.auditCollector.collectedPath);
  return {
    ...base,
    discovery: {
      providers,
      // 検索系APIの製品は未決（24.6）。実装はモックだけ
      search: new MockSearchProvider(),
    },
    audit: {
      collector,
      generator: createGenerationEvaluationGenerator({ db: base.db, clock: base.clock, generator, limiter }),
      runner,
      options: config.auditOptions,
    },
    generation: { generator, limiter },
    buildGenerationInput: defaultGenerationInputBuilder,
    siteBuilder: createAstroSiteBuilder(),
    demoArtifactRoot: config.demoArtifactRoot,
    policies: config.policies,
    discoveryStaleAfterMs: config.discoveryStaleAfterMs,
  };
}

/** ログに出してよい設定の要約（接続文字列・認証ファイルのパス等は出さない） */
export function describeConfig(config: WorkerConfig): Record<string, unknown> {
  return {
    generator: config.generator.kind,
    requestedModel: config.generator.kind === "codex" ? config.generator.model : null,
    discoveryProviders: config.discoveryProviders,
    auditCollector: config.auditCollector.kind,
    databaseConfigured: config.databaseUrl !== null,
  };
}
