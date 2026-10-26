import { existsSync } from "node:fs";
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
  TavilySearchProvider,
} from "@siteoffer/discovery";
import {
  CodexGenerator,
  ConcurrencyLimiter,
  codexProxyUrl,
  DEFAULT_GENERATION_LIMITS,
  DockerSandboxRunner,
  type Generator,
  MockGenerator,
} from "@siteoffer/generation";
import type { JobQueue, Logger, WorkerDeps } from "./deps.ts";
import { defaultGenerationInputBuilder, fixtureGenerationInputBuilder } from "./input.ts";
import { DEFAULT_POLICIES, DEFAULT_SCHEDULES, type StepKind, type StepPolicy } from "./queues.ts";
import { createAstroSiteBuilder } from "./site-builder.ts";
import {
  createDockerSiteBuilder,
  DEFAULT_SITE_BUILD_IMAGE,
  DEFAULT_SITE_BUILD_TIMEOUT_MS,
  siteBuildUserValid,
} from "./site-builder-docker.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export type GeneratorConfig =
  | { kind: "mock" }
  | {
      kind: "codex";
      image: string;
      network: string;
      codexAuthFile: string;
      model: string | null;
      user?: string;
      httpsProxy?: string;
    };

export type DiscoveryProviderName = "fixture" | "nta";

export interface WorkerConfig {
  /** pg-boss とDBの接続先。値はログに出さない */
  databaseUrl: string | null;
  discoveryOnly: boolean;
  generator: GeneratorConfig;
  siteBuild: { kind: "local" } | { kind: "docker"; image: string; timeoutMs: number; user: string };
  discoveryProviders: DiscoveryProviderName[];
  siteSearch: "fixture" | "none" | "tavily";
  searchLimit: number;
  auditCollector: { kind: "fixture"; collectedPath: string } | { kind: "python" };
  auditOptions: AuditOptions;
  demoArtifactRoot: string;
  /** 納品版のビルド結果の保存先（Gitに入れない場所） */
  deliveryArtifactRoot: string;
  /**
   * 生成の入力。default は収集した企業情報と診断から作る。
   * fixture は fixtures/codex/input.json（モックの固定応答と事実キーが揃った架空企業の入力）で、モック生成器のときだけ選べる（デモ用）
   */
  generationInput: "default" | "fixture";
  /** DBを見てジョブを受け付ける間隔（ミリ秒）。0 なら受付処理を動かさない */
  intakeIntervalMs: number;
  policies: Record<StepKind, StepPolicy>;
  schedules: {
    expireAssignments: string;
    recoverDiscovery: string;
    recoverGeneration: string;
    dispatchHandoffs: string;
    recoverPipeline: string;
  };
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
    let httpsProxy: string | undefined;
    try {
      httpsProxy = codexProxyUrl(v("SITEOFFER_CODEX_HTTPS_PROXY"));
    } catch {
      problems.push(
        "SITEOFFER_CODEX_HTTPS_PROXY は認証情報・パス・クエリを含まないhttp://ホスト:ポートで指定してください。",
      );
    }
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
        ...(httpsProxy ? { httpsProxy } : {}),
      };
  } else if (genKind !== "mock") {
    problems.push(`SITEOFFER_GENERATOR は mock か codex（${genKind}）`);
  }

  const siteKind = v("SITEOFFER_SITE_BUILDER") ?? (generator.kind === "codex" ? "docker" : "local");
  const siteBuildImage = v("SITEOFFER_SITE_BUILD_IMAGE") ?? DEFAULT_SITE_BUILD_IMAGE;
  const siteBuildTimeout = Number(v("SITEOFFER_SITE_BUILD_TIMEOUT_MS") ?? DEFAULT_SITE_BUILD_TIMEOUT_MS);
  const siteBuildUser =
    v("SITEOFFER_SITE_BUILD_USER") ??
    v("SITEOFFER_CODEX_USER") ??
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  if (siteKind === "docker" && !siteBuildUserValid(siteBuildUser))
    problems.push("SITEOFFER_SITE_BUILD_USER は非rootの数値UID:GIDで指定してください");
  if (!["local", "docker"].includes(siteKind)) problems.push("SITEOFFER_SITE_BUILDER は local・docker のいずれか");
  if (generator.kind === "codex" && siteKind !== "docker")
    problems.push("実Codexのサイト制作にはDockerビルドが必要です");
  if (!/^[a-z0-9][a-z0-9./_:@-]{0,254}$/i.test(siteBuildImage))
    problems.push("SITEOFFER_SITE_BUILD_IMAGE を確認してください");
  if (!Number.isSafeInteger(siteBuildTimeout) || siteBuildTimeout < 1000 || siteBuildTimeout > 900_000)
    problems.push("SITEOFFER_SITE_BUILD_TIMEOUT_MS は1000〜900000の整数");
  const siteBuild: WorkerConfig["siteBuild"] =
    siteKind === "docker"
      ? { kind: "docker", image: siteBuildImage, timeoutMs: siteBuildTimeout, user: siteBuildUser }
      : { kind: "local" };

  if (v("NODE_ENV") === "production" && generator.kind === "mock" && v("SITEOFFER_ALLOW_MOCK_DEMO") !== "true")
    problems.push(
      "本番モードでは実生成の設定が必要です。公開検証デモの場合だけ SITEOFFER_ALLOW_MOCK_DEMO=true を明示してください",
    );

  const discoveryProviders: DiscoveryProviderName[] = [];
  const providerSetting = v("SITEOFFER_DISCOVERY_PROVIDERS") ?? "fixture";
  for (const name of (providerSetting === "none" ? [] : providerSetting.split(",")).map((s) => s.trim())) {
    if (name === "fixture") discoveryProviders.push("fixture");
    else if (name === "nta") {
      if (!v("NTA_APPLICATION_ID")) problems.push("取得元 nta には環境変数 NTA_APPLICATION_ID が必要");
      else discoveryProviders.push("nta");
    } else if (name) problems.push(`未知の取得元：${name}`);
  }

  const collectorKind = v("SITEOFFER_AUDIT_COLLECTOR") ?? "fixture";
  const siteSearch =
    v("SITEOFFER_SEARCH_PROVIDER") ??
    (providerSetting !== "none" && discoveryProviders.every((name) => name === "fixture") ? "fixture" : "none");
  const searchLimit = Number(v("SITEOFFER_SEARCH_MAX_PER_RUN") ?? 50);
  if (!["fixture", "none", "tavily"].includes(siteSearch))
    problems.push("SITEOFFER_SEARCH_PROVIDER は fixture・none・tavily のいずれか");
  if (siteSearch === "fixture" && discoveryProviders.some((name) => name !== "fixture"))
    problems.push("実データ収集に模擬の検索結果は使えません");
  if (siteSearch === "tavily" && !v("TAVILY_API_KEY")) problems.push("実検索には TAVILY_API_KEY が必要です");
  if (!Number.isSafeInteger(searchLimit) || searchLimit < 1 || searchLimit > 1000)
    problems.push("SITEOFFER_SEARCH_MAX_PER_RUN は1〜1000の整数");
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

  const inputKind = v("SITEOFFER_GENERATION_INPUT") ?? "default";
  if (inputKind !== "default" && inputKind !== "fixture") {
    problems.push(`SITEOFFER_GENERATION_INPUT は default か fixture（${inputKind}）`);
  } else if (inputKind === "fixture" && generator.kind !== "mock") {
    problems.push("SITEOFFER_GENERATION_INPUT=fixture はモック生成器（SITEOFFER_GENERATOR=mock）のときだけ使える");
  }

  const intakeIntervalMs = Number(v("SITEOFFER_INTAKE_INTERVAL_MS") ?? 5000);
  if (!Number.isInteger(intakeIntervalMs) || intakeIntervalMs < 0) problems.push("SITEOFFER_INTAKE_INTERVAL_MS が不正");

  // 評価設定（閾値など）。既定は config/site-evaluation.json。デモでは config/site-evaluation.demo.json を指定する
  const evalConfig = v("SITEOFFER_EVAL_CONFIG");
  const evalConfigPath = evalConfig ? path.resolve(REPO_ROOT, evalConfig) : undefined;
  if (evalConfigPath && !existsSync(evalConfigPath)) problems.push("SITEOFFER_EVAL_CONFIG のファイルがない");

  // 提案の同時実行数（このプロセス内）。Astroのビルドが同時に走るとメモリを使うため、デモでは 1 にする
  const proposalConcurrency = Number(v("SITEOFFER_PROPOSAL_CONCURRENCY") ?? DEFAULT_GENERATION_LIMITS.maxConcurrent);
  if (!Number.isInteger(proposalConcurrency) || proposalConcurrency < 1) {
    problems.push("SITEOFFER_PROPOSAL_CONCURRENCY が不正");
  }

  const staleMinutes = Number(v("SITEOFFER_DISCOVERY_STALE_MINUTES") ?? 60);
  if (!Number.isFinite(staleMinutes) || staleMinutes < 1) problems.push("SITEOFFER_DISCOVERY_STALE_MINUTES が不正");

  if (problems.length) return err("invalid_config", problems.join("。"));
  return ok({
    databaseUrl: v("DATABASE_URL") ?? null,
    discoveryOnly: v("SITEOFFER_DISCOVERY_ONLY") === "true",
    generator,
    siteBuild,
    discoveryProviders,
    siteSearch: siteSearch as WorkerConfig["siteSearch"],
    searchLimit,
    auditCollector,
    auditOptions: defaultAuditOptions(env, {
      paths: { repoRoot: REPO_ROOT, ...(evalConfigPath ? { configPath: evalConfigPath } : {}) },
    }),
    demoArtifactRoot: v("SITEOFFER_DEMO_ARTIFACT_DIR") ?? path.join(REPO_ROOT, "reports/app/demos"),
    deliveryArtifactRoot: v("SITEOFFER_DELIVERY_ARTIFACT_DIR") ?? path.join(REPO_ROOT, "reports/app/deliveries"),
    generationInput: inputKind === "fixture" ? "fixture" : "default",
    intakeIntervalMs,
    policies: DEFAULT_POLICIES,
    schedules: { ...DEFAULT_SCHEDULES },
    discoveryStaleAfterMs: staleMinutes * 60 * 1000,
    concurrency: { discovery: 1, audit: 2, proposal: proposalConcurrency },
  });
}

export function createGenerator(config: GeneratorConfig, env: NodeJS.ProcessEnv = process.env): Generator {
  if (config.kind === "mock") return new MockGenerator();
  const runner = new DockerSandboxRunner(
    {
      image: config.image,
      network: config.network,
      ...(config.httpsProxy ? { httpsProxy: config.httpsProxy } : {}),
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
  if (config.generator.kind === "codex" && config.siteBuild.kind !== "docker")
    throw new Error("実Codexのサイト制作にはDockerビルドが必要です");
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
    discoveryOnly: config.discoveryOnly,
    preparation: { auditCollector: config.auditCollector.kind, generationInput: config.generationInput },
    discovery: {
      providers,
      ...(config.siteSearch === "fixture"
        ? { search: new MockSearchProvider() }
        : config.siteSearch === "tavily"
          ? { search: new TavilySearchProvider() }
          : {}),
      searchLimit: config.searchLimit,
    },
    audit: {
      collector,
      generator: createGenerationEvaluationGenerator({ db: base.db, clock: base.clock, generator, limiter }),
      runner,
      options: config.auditOptions,
    },
    generation: { generator, limiter },
    buildGenerationInput:
      config.generationInput === "fixture" ? fixtureGenerationInputBuilder : defaultGenerationInputBuilder,
    siteBuilder:
      config.siteBuild.kind === "docker" ? createDockerSiteBuilder(config.siteBuild) : createAstroSiteBuilder(),
    demoArtifactRoot: config.demoArtifactRoot,
    deliveryArtifactRoot: config.deliveryArtifactRoot,
    policies: config.policies,
    discoveryStaleAfterMs: config.discoveryStaleAfterMs,
  };
}

/** ログに出してよい設定の要約（接続文字列・認証ファイルのパス等は出さない） */
export function describeConfig(config: WorkerConfig): Record<string, unknown> {
  return {
    generator: config.generator.kind,
    siteBuilder: config.siteBuild.kind,
    requestedModel: config.generator.kind === "codex" ? config.generator.model : null,
    discoveryProviders: config.discoveryProviders,
    discoveryOnly: config.discoveryOnly,
    siteSearch: config.siteSearch,
    searchLimit: config.searchLimit,
    auditCollector: config.auditCollector.kind,
    generationInput: config.generationInput,
    evaluationConfig: path.relative(REPO_ROOT, config.auditOptions.paths.configPath),
    intakeIntervalMs: config.intakeIntervalMs,
    databaseConfigured: config.databaseUrl !== null,
  };
}
