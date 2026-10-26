import { expect, it } from "vitest";
import { buildCodexProcessEnv, codexProxyUrl, isInternalProxyNetwork } from "../src/sandbox/environment.ts";

it("normalizes only an explicitly configured credential-free CONNECT proxy", () => {
  expect(codexProxyUrl("http://proxy:3128/")).toBe("http://proxy:3128");
  expect(codexProxyUrl("http://[fd00::2]:3128")).toBe("http://[fd00::2]:3128");
  expect(codexProxyUrl("")).toBeUndefined();
  expect(codexProxyUrl(undefined)).toBeUndefined();
});

it.each([
  "https://proxy:3128",
  "socks5://proxy:3128",
  "http://user:private-proxy-password@proxy:3128",
  "http://proxy:3128/path",
  "http://proxy:3128/?secret=value",
  "http://proxy:3128/#fragment",
  "http://proxy:0",
  "http://proxy:99999",
  "http://proxy\n.invalid:3128",
  "http://proxy:3128/../",
])("refuses unsafe proxy URL components without echoing their contents: %s", (value) => {
  expect(() => codexProxyUrl(value)).toThrow("生成用プロキシ");
  try {
    codexProxyUrl(value);
  } catch (error) {
    expect((error as Error).message).not.toContain(value);
    expect((error as Error).message).not.toContain("private-proxy-password");
  }
});

it("does not inherit ambient proxy bypasses, credentials or app settings into the CLI", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/codex",
    CODEX_HOME: "/home/codex/.codex",
    LANG: "C.UTF-8",
    TZ: "UTC",
    HTTP_PROXY: "http://ambient.invalid:3128",
    HTTPS_PROXY: "http://ambient.invalid:3128",
    ALL_PROXY: "http://ambient.invalid:3128",
    NO_PROXY: "*",
    https_proxy: "http://ambient.invalid:3128",
    no_proxy: "*",
    DATABASE_URL: "test-only-db",
    OPENAI_API_KEY: "test-only-key",
    NODE_OPTIONS: "test-only-options",
  };
  const base = {
    PATH: source.PATH,
    HOME: source.HOME,
    CODEX_HOME: source.CODEX_HOME,
    LANG: source.LANG,
    TZ: source.TZ,
  };
  expect(buildCodexProcessEnv(source)).toEqual(base);
  expect(buildCodexProcessEnv({ ...source, SITEOFFER_CODEX_HTTPS_PROXY: "http://proxy:3128/" })).toEqual({
    ...base,
    HTTP_PROXY: "http://proxy:3128",
    HTTPS_PROXY: "http://proxy:3128",
  });
});

it.each([
  "null",
  "[]",
  "{}",
  "broken",
  '{"Driver":"host","Internal":true}',
  '{"Driver":"bridge","Internal":false}',
  '{"Driver":"bridge","Internal":"true"}',
])("does not mistake incomplete or public Docker metadata for an internal proxy network: %s", (value) => {
  expect(isInternalProxyNetwork(value)).toBe(false);
});
it("accepts only a real internal bridge flag", () => {
  expect(isInternalProxyNetwork('{"Driver":"bridge","Internal":true}')).toBe(true);
});
