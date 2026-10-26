import { expect, it } from "vitest";
import { describeConfig, resolveWorkerConfig } from "../apps/worker/src/config.ts";
import { demoSearchEnv } from "./search-env.ts";

it("normal and restored demos never inherit a paid search key or provider", () => {
  expect(demoSearchEnv({ SITEOFFER_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: "test-only" }, false)).toEqual({
    SITEOFFER_SEARCH_PROVIDER: "fixture",
    TAVILY_API_KEY: "",
  });
});
it("real discovery still requires explicit search opt-in and retains invalid modes for validation", () => {
  expect(demoSearchEnv({ TAVILY_API_KEY: "test-only" }, true)).toEqual({
    SITEOFFER_SEARCH_PROVIDER: "none",
    TAVILY_API_KEY: "",
  });
  expect(demoSearchEnv({ SITEOFFER_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: "test-only" }, true).TAVILY_API_KEY).toBe(
    "test-only",
  );
  expect(
    demoSearchEnv({ SITEOFFER_SEARCH_PROVIDER: "invalid", TAVILY_API_KEY: "test-only" }, true)
      .SITEOFFER_SEARCH_PROVIDER,
  ).toBe("invalid");
});
it("configuration rejects missing keys, fake search with real data and invalid budgets without printing a key", () => {
  const real = { SITEOFFER_DISCOVERY_PROVIDERS: "nta", NTA_APPLICATION_ID: "test-only" };
  expect(resolveWorkerConfig({}).ok).toBe(true);
  const defaultReal = resolveWorkerConfig(real);
  expect(defaultReal.ok && defaultReal.value.siteSearch).toBe("none");
  for (const env of [
    { SITEOFFER_SEARCH_PROVIDER: "tavily" },
    { ...real, SITEOFFER_SEARCH_PROVIDER: "fixture" },
    { SITEOFFER_SEARCH_MAX_PER_RUN: "0" },
    { SITEOFFER_SEARCH_MAX_PER_RUN: "1.5" },
    { SITEOFFER_SEARCH_MAX_PER_RUN: "1001" },
    { SITEOFFER_SEARCH_PROVIDER: "invalid" },
  ])
    expect(resolveWorkerConfig(env).ok).toBe(false);
  const r = resolveWorkerConfig({
    ...real,
    SITEOFFER_SEARCH_PROVIDER: "tavily",
    TAVILY_API_KEY: "test-only-private-key",
    SITEOFFER_SEARCH_MAX_PER_RUN: "2",
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(describeConfig(r.value)).toMatchObject({ siteSearch: "tavily", searchLimit: 2 });
  expect(JSON.stringify(r)).not.toContain("test-only-private-key");
});
