import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DockerSandboxRunner } from "../packages/generation/src/sandbox/docker.ts";

const image = process.env.SITEOFFER_CODEX_IMAGE;
const network = process.env.SITEOFFER_CODEX_NETWORK;
const codexAuthFile = process.env.SITEOFFER_CODEX_AUTH_FILE;
assert(image && network && codexAuthFile, "pnpm codex:setup を先に実行してください");
const auth = JSON.parse(await readFile(codexAuthFile, "utf8"));
assert.equal(auth.auth_mode, "chatgpt", "ChatGPTログインを使うこと");
const workDir = await mkdtemp(path.join(tmpdir(), "siteoffer-auth-check-"));
try {
  const runner = new DockerSandboxRunner({
    image,
    network,
    ...(process.env.SITEOFFER_CODEX_HTTPS_PROXY ? { httpsProxy: process.env.SITEOFFER_CODEX_HTTPS_PROXY } : {}),
    codexAuthFile,
    user: process.env.SITEOFFER_CODEX_USER ?? "1000:1000",
  });
  const outcome = await runner.run({
    jobId: `auth-check-${Date.now()}`,
    workDir,
    timeoutMs: 90_000,
    request: {
      prompt: "Reply with exactly SITEOFFER_AUTH_OK. Do not run tools, read files, or access the web.",
      model: process.env.SITEOFFER_CODEX_MODEL || null,
      outputSchema: null,
      images: [],
      thread: {
        sandboxMode: "read-only",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        approvalPolicy: "never",
        modelReasoningEffort: "low",
      },
    },
  });
  if (!outcome.ok) throw new Error(`Codex SDKの認証確認が失敗しました: ${outcome.message}`);
  assert.equal(outcome.result.finalResponse?.trim(), "SITEOFFER_AUTH_OK");
  console.log(
    JSON.stringify({
      authenticatedWith: "existing-chatgpt-login",
      sdkVersion: outcome.result.sdkVersion,
      cliVersion: outcome.result.cliVersion,
      requestedModel: process.env.SITEOFFER_CODEX_MODEL || null,
      responseModel: outcome.result.responseModel,
      usage: outcome.result.usage,
      ok: true,
    }),
  );
} finally {
  const resolved = path.resolve(workDir);
  assert(
    resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
      path.basename(resolved).startsWith("siteoffer-auth-check-"),
    "Unexpected authentication check directory",
  );
  await rm(resolved, { recursive: true, force: true });
}
