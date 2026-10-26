import { expect, it } from "vitest";
import { resolveWorkerConfig } from "../apps/worker/src/config.ts";
import { demoGenerationEnv, demoPublicEnv, resolveDemoMode } from "./generation-mode.ts";

const real = resolveDemoMode(["--resume", "--real-generation"], {});
const source = {
  OPENAI_API_KEY: "test-only-image-secret",
  CODEX_API_KEY: "test-only-codex-secret",
  TAVILY_API_KEY: "test-only-search-secret",
  NTA_APPLICATION_ID: "test-only-nta-secret",
  SITEOFFER_CODEX_AUTH_FILE: "/private/test-auth.json",
  SITEOFFER_CODEX_IMAGE: "siteoffer-codex:test",
  SITEOFFER_CODEX_NETWORK: "test-egress",
  SITEOFFER_CODEX_HTTPS_PROXY: "http://proxy:3128",
  SITEOFFER_CODEX_MODEL: "explicit-test-model",
  SITEOFFER_CODEX_USER: "1001:1001",
  SITEOFFER_SITE_BUILDER: "local",
  SITEOFFER_GENERATOR: "codex",
  SITEOFFER_GENERATION_INPUT: "fixture",
};

it.each([{ args: [] }, { args: ["--resume"] }])(
  "never enables real generation from inherited settings: $args",
  ({ args }) => {
    const mode = resolveDemoMode(args, source);
    const env = { ...demoPublicEnv(source, mode), ...demoGenerationEnv(source, mode) };
    expect(mode.realGeneration).toBe(false);
    expect(env).toMatchObject({
      SITEOFFER_GENERATOR: "mock",
      SITEOFFER_GENERATION_INPUT: "fixture",
      SITEOFFER_CODEX_AUTH_FILE: "",
      SITEOFFER_SITE_BUILDER: "local",
    });
  },
);
it.each([
  ["--real-generation"],
  ["--real-generation", "--reset"],
  ["--real-generation", "--resume", "--reset"],
  ["--real-generation", "--resume", "--real-discovery"],
])("refuses unsafe generation launch flags before any process is started: %j", (...args) => {
  expect(() => resolveDemoMode(args, {})).toThrow();
});
it("does not activate real generation on restored verification data", () => {
  expect(() => resolveDemoMode(["--resume", "--real-generation"], { DEMO_RESTORE_DIR: "test-restore" })).toThrow(
    "復元確認用",
  );
});
it("passes only Codex launch settings to the worker, leaving paid API keys blank", () => {
  const publicEnv = demoPublicEnv(source, real);
  const worker = { ...publicEnv, ...demoGenerationEnv(source, real) };
  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "NTA_APPLICATION_ID",
    "TAVILY_API_KEY",
    "SITEOFFER_CODEX_AUTH_FILE",
    "SITEOFFER_CODEX_MODEL",
    "SITEOFFER_CODEX_USER",
    "SITEOFFER_CODEX_HTTPS_PROXY",
  ])
    expect(publicEnv[key]).toBe("");
  expect(worker).toMatchObject({
    SITEOFFER_GENERATOR: "codex",
    SITEOFFER_GENERATION_INPUT: "default",
    SITEOFFER_AUDIT_COLLECTOR: "python",
    SITEOFFER_SITE_BUILDER: "docker",
    SITEOFFER_DISCOVERY_PROVIDERS: "none",
    SITEOFFER_SEARCH_PROVIDER: "none",
    SITEOFFER_EVAL_CONFIG: "config/site-evaluation.json",
    SITEOFFER_CODEX_MODEL: "explicit-test-model",
    SITEOFFER_CODEX_USER: "1001:1001",
    SITEOFFER_CODEX_HTTPS_PROXY: "http://proxy:3128",
    OPENAI_API_KEY: "",
    CODEX_API_KEY: "",
  });
  const config = resolveWorkerConfig(worker);
  expect(config.ok).toBe(true);
  if (config.ok)
    expect(config.value).toMatchObject({
      generationInput: "default",
      discoveryProviders: [],
      generator: { kind: "codex", model: "explicit-test-model", httpsProxy: "http://proxy:3128" },
      siteBuild: { kind: "docker" },
      auditCollector: { kind: "python" },
    });
  expect(source.OPENAI_API_KEY).toBe("test-only-image-secret");
});
it("retains the existing SDK model default when no model was selected", () => {
  const modeEnv = demoGenerationEnv({}, real);
  expect(modeEnv.SITEOFFER_CODEX_MODEL).toBeUndefined();
  expect(modeEnv.SITEOFFER_EVAL_CONFIG).toBe("config/site-evaluation.json");
});
it("keeps real collection separate and preserves its existing explicit search opt-in", () => {
  const mode = resolveDemoMode(["--resume", "--real-discovery"], {});
  const env = {
    ...demoPublicEnv({ ...source, SITEOFFER_SEARCH_PROVIDER: "tavily" }, mode),
    ...demoGenerationEnv(source, mode),
  };
  expect(env).toMatchObject({
    SITEOFFER_GENERATOR: "mock",
    SITEOFFER_DISCOVERY_ONLY: "true",
    SITEOFFER_DISCOVERY_PROVIDERS: "nta",
    NTA_APPLICATION_ID: "test-only-nta-secret",
    TAVILY_API_KEY: "test-only-search-secret",
    SITEOFFER_CODEX_AUTH_FILE: "",
  });
});
