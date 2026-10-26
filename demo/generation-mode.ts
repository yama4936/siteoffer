import { demoSearchEnv } from "./search-env.ts";

export interface DemoMode {
  realDiscovery: boolean;
  realGeneration: boolean;
  resume: boolean;
  reset: boolean;
}

/** A model setting inherited from the shell never opts the local demo into real generation. */
export function resolveDemoMode(args: string[], env: NodeJS.ProcessEnv): DemoMode {
  const mode = {
    realDiscovery: args.includes("--real-discovery"),
    realGeneration: args.includes("--real-generation"),
    resume: args.includes("--resume"),
    reset: args.includes("--reset"),
  };
  if (mode.resume && mode.reset) throw new Error("継続起動と初期化は同時に指定できません。");
  if (mode.realGeneration && (!mode.resume || mode.reset))
    throw new Error("実生成は pnpm demo:codex で既存DBを継続起動してください。初期化・シードは行いません。");
  if (mode.realGeneration && mode.realDiscovery) throw new Error("実生成と国税庁の実収集は別々に起動してください。");
  if (mode.realGeneration && env.DEMO_RESTORE_DIR) throw new Error("復元確認用データでは実生成を起動しません。");
  return mode;
}

const CODEX_KEYS = [
  "SITEOFFER_CODEX_AUTH_FILE",
  "SITEOFFER_CODEX_IMAGE",
  "SITEOFFER_CODEX_NETWORK",
  "SITEOFFER_CODEX_HTTPS_PROXY",
  "SITEOFFER_CODEX_MODEL",
  "SITEOFFER_CODEX_USER",
] as const;

/** Blank values also stop Next.js from loading those secrets back from the root .env. */
export function demoPublicEnv(source: NodeJS.ProcessEnv, mode: DemoMode): NodeJS.ProcessEnv {
  const env = { ...source, ...demoSearchEnv(source, mode.realDiscovery) };
  for (const key of [
    ...CODEX_KEYS,
    "SITEOFFER_SHARE_TOKEN_KEY",
    "NTA_APPLICATION_ID",
    "PSI_API_KEY",
    "OPENAI_API_KEY",
    "SITEOFFER_IMAGE_MODEL",
    "CODEX_API_KEY",
    "SITEOFFER_BACKUP_PASSPHRASE",
  ])
    env[key] = "";
  if (mode.realDiscovery) env.NTA_APPLICATION_ID = source.NTA_APPLICATION_ID;
  env.SITEOFFER_DEMO_MODE = mode.realDiscovery || mode.realGeneration ? "false" : "true";
  env.SITEOFFER_DISCOVERY_ONLY = mode.realDiscovery ? "true" : "false";
  return env;
}

/** Real generation uses the existing default input builder and isolated Docker builders. */
export function demoGenerationEnv(source: NodeJS.ProcessEnv, mode: DemoMode): NodeJS.ProcessEnv {
  if (!mode.realGeneration)
    return {
      SITEOFFER_GENERATOR: "mock",
      SITEOFFER_GENERATION_INPUT: "fixture",
      SITEOFFER_AUDIT_COLLECTOR: "fixture",
      SITEOFFER_SITE_BUILDER: "local",
      SITEOFFER_DISCOVERY_PROVIDERS: mode.realDiscovery ? "nta" : "fixture",
      SITEOFFER_EVAL_CONFIG: "config/site-evaluation.demo.json",
    };
  const env: NodeJS.ProcessEnv = {
    SITEOFFER_GENERATOR: "codex",
    SITEOFFER_GENERATION_INPUT: "default",
    SITEOFFER_AUDIT_COLLECTOR: "python",
    SITEOFFER_SITE_BUILDER: "docker",
    // Collection has its own explicit launch mode. Never fabricate evidence for a real generation.
    SITEOFFER_DISCOVERY_PROVIDERS: "none",
    SITEOFFER_SEARCH_PROVIDER: "none",
    SITEOFFER_EVAL_CONFIG: source.SITEOFFER_EVAL_CONFIG?.trim() || "config/site-evaluation.json",
  };
  for (const key of [
    ...CODEX_KEYS,
    "SITEOFFER_SITE_BUILD_IMAGE",
    "SITEOFFER_SITE_BUILD_USER",
    "SITEOFFER_SITE_BUILD_TIMEOUT_MS",
    "SITEOFFER_PYTHON_BIN",
  ])
    if (source[key] !== undefined) env[key] = source[key];
  return env;
}
