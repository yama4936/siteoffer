import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DockerSandboxRunner } from "../packages/generation/src/sandbox/docker.ts";
import type { SandboxRequest } from "../packages/generation/src/sandbox/types.ts";

// Offline transport check: a dummy credential and network=none; no model request.
const root = await mkdtemp(path.join(tmpdir(), "siteoffer-sandbox-check-"));
const workDir = path.join(root, "作業 ディレクトリ");
const authFile = path.join(root, "認証 dummy.json");
const dummyAuth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "offline-check-only" } });
const image = process.env.SITEOFFER_CODEX_IMAGE || "siteoffer-codex:local";
try {
  await mkdir(workDir);
  await writeFile(authFile, dummyAuth);
  await writeFile(
    path.join(workDir, "offline-check.mjs"),
    `import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
const request = JSON.parse(readFileSync('request.json', 'utf8'));
if (request.prompt === 'stale') process.exit(0);
assert.equal(process.getuid(), 1000);
for (const key of ['DATABASE_URL', 'OPENAI_API_KEY', 'SITEOFFER_CHECK_SECRET']) assert.equal(process.env[key], undefined);
assert.equal(JSON.parse(readFileSync('/run/siteoffer-auth.json', 'utf8')).tokens.access_token, 'offline-check-only');
assert.throws(() => appendFileSync('/run/siteoffer-auth.json', 'x'));
assert.throws(() => writeFileSync('/app/root-write-check', 'x'));
mkdirSync('out', { recursive: true });
writeFileSync('out/result.json', JSON.stringify({
  executionId: request.executionId, ok: true, threadId: null,
  finalResponse: 'OFFLINE_SANDBOX_OK', usage: null, responseModel: null,
  sdkVersion: null, cliVersion: null, error: null
}));
process.exit(request.prompt === 'nonzero' ? 42 : 0);
`,
  );
  const config = { image, network: "none", codexAuthFile: authFile };
  const runner = new DockerSandboxRunner(
    { ...config, entryCommand: ["node", "/work/offline-check.mjs"] },
    {
      ...process.env,
      DATABASE_URL: "offline-sentinel",
      OPENAI_API_KEY: "offline-sentinel",
      SITEOFFER_CHECK_SECRET: "offline-sentinel",
    },
  );
  const request: SandboxRequest = {
    prompt: "ok",
    outputSchema: null,
    model: null,
    images: [],
    thread: {
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
      modelReasoningEffort: null,
    },
  };
  const run = (target: DockerSandboxRunner, prompt: string) =>
    target.run({
      jobId: `offline-check-${randomUUID()}`,
      workDir,
      timeoutMs: 30_000,
      request: { ...request, prompt },
    });
  const good = await run(runner, "ok");
  assert(good.ok, JSON.stringify(good));
  assert.equal(good.result.finalResponse, "OFFLINE_SANDBOX_OK");
  const stale = await run(runner, "stale");
  assert(!stale.ok && stale.result === null, "A previous receipt must not become the current success");
  const nonzero = await run(runner, "nonzero");
  assert(!nonzero.ok && nonzero.message.includes("42"), "A failing process must not become a success");
  const entry = await run(new DockerSandboxRunner(config), "");
  const entryResult = entry.result;
  assert(!entry.ok && entryResult, JSON.stringify(entry));
  assert(entryResult.error?.includes("request.json が不正"), JSON.stringify(entry));
  assert.equal(entryResult.sdkVersion, "0.162.1");
  assert.equal(await readFile(authFile, "utf8"), dummyAuth);
  console.log(
    JSON.stringify({
      ok: true,
      mode: "offline-sandbox-transport",
      realModelCall: false,
      network: "none",
      image,
      nativePathWithSpacesAndJapanese: true,
      user: "1000:1000",
      authReadOnly: true,
      applicationSecretsAbsent: true,
      rootWriteRejected: true,
      staleReceiptRejected: true,
      nonzeroExitRejected: true,
      realEntryValidation: true,
      sdkVersion: entryResult.sdkVersion,
      cliVersion: entryResult.cliVersion,
    }),
  );
} finally {
  const resolved = path.resolve(root);
  assert(
    resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
      path.basename(resolved).startsWith("siteoffer-sandbox-check-"),
  );
  await rm(resolved, { recursive: true, force: true });
}
