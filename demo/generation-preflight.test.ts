import path from "node:path";
import { expect, it, vi } from "vitest";
import { RUNTIME_KIND_LABEL, RUNTIME_SOURCE_LABEL, runtimeSourceFingerprint } from "../scripts/runtime-fingerprint.ts";
import { demoGenerationEnv, resolveDemoMode } from "./generation-mode.ts";
import { generationPreflight, type PreflightDeps } from "./generation-preflight.ts";

const mode = resolveDemoMode(["--resume", "--real-generation"], {});
const env = demoGenerationEnv(
  {
    SITEOFFER_CODEX_AUTH_FILE: path.resolve("test-auth-file.json"),
    SITEOFFER_CODEX_IMAGE: "siteoffer-codex:test",
    SITEOFFER_CODEX_NETWORK: "test-egress",
    SITEOFFER_CODEX_USER: "1000:1000",
  },
  mode,
);
function fake() {
  return {
    readableFile: vi.fn(async () => true),
    command: vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "docker") {
        if (args[0] === "version") return "linux";
        if (args[0] === "network") return "bridge";
        const kind = args.at(-1) === "siteoffer-codex:test" ? "codex" : "site";
        return JSON.stringify({
          [RUNTIME_KIND_LABEL]: kind,
          [RUNTIME_SOURCE_LABEL]: await runtimeSourceFingerprint(kind),
        });
      }
      return "3";
    }),
  } satisfies PreflightDeps;
}
it("checks only metadata and reports the limits of each successful check", async () => {
  const deps = fake();
  const result = await generationPreflight(env, deps);
  expect(result.every((check) => check.ok)).toBe(true);
  expect(deps.readableFile).toHaveBeenCalledExactlyOnceWith(env.SITEOFFER_CODEX_AUTH_FILE);
  expect(deps.command.mock.calls.filter(([cmd]) => cmd === "docker").map(([, args]) => args[0])).toEqual([
    "version",
    "image",
    "image",
    "network",
  ]);
  expect(JSON.stringify(result)).toContain("ログインの有効性は未検証");
  expect(JSON.stringify(result)).toContain("実行品質は未検証");
  expect(JSON.stringify(result)).not.toContain("test-auth-file");
});
it.each(["host", "none", "--invalid", "bad\nnetwork"])("rejects unsafe or unusable networks: %s", async (network) => {
  const deps = fake();
  const result = await generationPreflight({ ...env, SITEOFFER_CODEX_NETWORK: network }, deps);
  expect(result.find((check) => check.name === "生成ネットワーク")?.ok).toBe(false);
  expect(deps.command.mock.calls.some(([, args]) => args[0] === "network")).toBe(false);
});
it.each(["0:0", "root", "-1:1000"])("rejects a root or invalid generation user: %s", async (user) => {
  expect(
    (await generationPreflight({ ...env, SITEOFFER_CODEX_USER: user }, fake())).find(
      (check) => check.name === "生成ユーザー",
    )?.ok,
  ).toBe(false);
});
it("fails closed for unreadable auth and missing images without exposing errors", async () => {
  const deps = fake();
  deps.readableFile.mockRejectedValue(new Error("private-test-auth-content"));
  deps.command.mockRejectedValue(new Error("private-test-daemon-settings"));
  const result = await generationPreflight(env, deps);
  expect(result.filter((check) => !check.ok).map((check) => check.name)).toEqual([
    "認証ファイル",
    "Docker",
    "生成イメージ",
    "ビルドイメージ",
    "生成ネットワーク",
    "Python",
  ]);
  expect(JSON.stringify(result)).not.toContain("private-test");
});
it("does not fall back to mock or fixture input on incomplete configuration", async () => {
  const result = await generationPreflight(
    { ...env, SITEOFFER_CODEX_AUTH_FILE: "", SITEOFFER_GENERATION_INPUT: "fixture" },
    fake(),
  );
  expect(result.find((check) => check.name === "実生成の構成")?.ok).toBe(false);
  expect(result.find((check) => check.name === "認証ファイル")?.ok).toBe(false);
});
it.each([
  "null",
  "{}",
  '{"org.siteoffer.runtime.kind":"site","org.siteoffer.runtime.source-sha256":"old"}',
  "not-json",
])("rejects an existing image whose source stamp is missing, stale or unreadable: %s", async (labels) => {
  const deps = fake();
  const command = deps.command.getMockImplementation()!;
  deps.command.mockImplementation(async (cmd, args) => (args[0] === "image" ? labels : command(cmd, args)));
  const result = await generationPreflight(env, deps);
  expect(result.filter((check) => !check.ok).map((check) => check.name)).toEqual(["生成イメージ", "ビルドイメージ"]);
  expect(result.find((check) => check.name === "ビルドイメージ")?.message).toContain("pnpm site:build");
  expect(JSON.stringify(result)).not.toContain(labels);
});
