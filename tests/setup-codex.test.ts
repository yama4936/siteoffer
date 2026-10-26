import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv, promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const exec = promisify(execFile);
let root: string, authDir: string, authText: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "siteoffer-setup-check-"));
  authDir = path.join(root, "認証 dummy home");
  authText = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test-only-access" } });
  await mkdir(authDir);
  await writeFile(path.join(authDir, "auth.json"), authText);
  await mkdir(path.join(root, "scripts"));
  await copyFile(new URL("../scripts/setup-codex.mjs", import.meta.url), path.join(root, "scripts/setup-codex.mjs"));
});
afterEach(async () => {
  const resolved = path.resolve(root);
  if (
    !resolved.startsWith(path.resolve(tmpdir()) + path.sep) ||
    !path.basename(resolved).startsWith("siteoffer-setup-check-")
  )
    throw new Error("Unexpected setup test directory");
  await rm(resolved, { recursive: true, force: true });
});
const run = () =>
  exec(process.execPath, [path.join(root, "scripts/setup-codex.mjs")], {
    env: { ...process.env, CODEX_HOME: authDir, PATH: path.join(root, "no-cli-installed") },
  });
it("writes a dotenv-compatible native auth path without invoking a shell shim or copying tokens", async () => {
  await writeFile(path.join(root, ".env"), "DATABASE_URL=local-test-only\nSITEOFFER_GENERATOR=mock\n");
  const { stdout } = await run();
  const envText = await readFile(path.join(root, ".env"), "utf8");
  const env = parseEnv(envText);
  expect(env.SITEOFFER_CODEX_AUTH_FILE).toBe(path.join(authDir, "auth.json").replaceAll("\\", "/"));
  expect(env.DATABASE_URL).toBe("local-test-only");
  expect(env.SITEOFFER_GENERATOR).toBe("codex");
  expect(envText).not.toContain("test-only-access");
  expect(await readFile(path.join(authDir, "auth.json"), "utf8")).toBe(authText);
  expect(stdout).toContain("pnpm codex:check");
  await run();
  expect(await readFile(path.join(root, ".env"), "utf8")).toBe(envText);
});
it("explains missing local configuration without creating it or modifying authentication", async () => {
  await expect(run()).rejects.toMatchObject({ stderr: expect.stringContaining("pnpm dev:setup") });
  await expect(readFile(path.join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(authDir, "auth.json"), "utf8")).toBe(authText);
});
it("rejects API-key authentication before updating local configuration", async () => {
  await writeFile(path.join(root, ".env"), "SITEOFFER_GENERATOR=mock\n");
  await writeFile(path.join(authDir, "auth.json"), JSON.stringify({ auth_mode: "apikey" }));
  await expect(run()).rejects.toMatchObject({ stderr: expect.stringContaining("ChatGPTログイン") });
  expect(await readFile(path.join(root, ".env"), "utf8")).toBe("SITEOFFER_GENERATOR=mock\n");
});
