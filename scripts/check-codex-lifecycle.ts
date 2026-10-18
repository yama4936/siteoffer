import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildDockerClientEnv, DockerSandboxRunner } from "../packages/generation/src/sandbox/docker.ts";
import { runDockerCommand } from "../packages/generation/src/sandbox/docker-process.ts";
import { recoverDockerExecution } from "../packages/generation/src/sandbox/stop-recovery.ts";
import type {
  SandboxRequest,
  SandboxRunOutcome,
  SandboxStopReference,
} from "../packages/generation/src/sandbox/types.ts";

// Offline lifecycle proof. No real credentials, SDK turn, network, or application database.
const root = await mkdtemp(path.join(tmpdir(), "siteoffer-lifecycle-check-"));
const image = process.env.SITEOFFER_CODEX_IMAGE || "siteoffer-codex:local";
const env = buildDockerClientEnv(process.env),
  authFile = path.join(root, "dummy-auth.json");
const controllers: AbortController[] = [],
  pending: Promise<SandboxRunOutcome>[] = [],
  ownedNames: string[] = [];
const request: SandboxRequest = {
  prompt: "offline",
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
const command = (args: string[]) => runDockerCommand("docker", args, env, 10_000, undefined, undefined, true);
const absent = async (name: string) => {
  const result = await command(["inspect", "--type", "container", name]);
  return result.closed && result.code === 1 && /No such (container|object)/i.test(result.stderr);
};
async function waitForFile(file: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(file, "utf8");
    } catch {
      await delay(25);
    }
  }
  throw Error("Offline container did not begin writing before the deadline");
}
async function start(label: string, jobId: string, timeoutMs: number) {
  const dir = path.join(root, label);
  await mkdir(dir);
  await writeFile(
    path.join(dir, "offline.mjs"),
    `
import {writeFileSync} from 'node:fs';
writeFileSync('started.txt', 'started');
let ticks = 0;
setInterval(() => writeFileSync('heartbeat.txt', String(++ticks)), 50);
setTimeout(() => writeFileSync('late.txt', 'must not appear'), 5000);
`,
  );
  const controller = new AbortController();
  controllers.push(controller);
  const runner = new DockerSandboxRunner({
    image,
    network: "none",
    codexAuthFile: authFile,
    entryCommand: ["node", "/work/offline.mjs"],
  });
  const result = runner.run({ jobId, workDir: dir, timeoutMs, signal: controller.signal, request });
  pending.push(result);
  await waitForFile(path.join(dir, "heartbeat.txt"));
  return { dir, controller, result };
}
async function stable(dir: string) {
  const file = path.join(dir, "heartbeat.txt"),
    before = await readFile(file, "utf8");
  await delay(250);
  assert.equal(await readFile(file, "utf8"), before, "A stopped container must not keep writing");
}
try {
  await writeFile(authFile, "{}");
  const jobId = randomUUID();
  const first = await start("abort", jobId, 15_000);
  const other = await start("other-execution", jobId, 15_000);
  first.controller.abort();
  const aborted = await first.result;
  assert(!aborted.ok && aborted.error === "aborted" && aborted.stopped, JSON.stringify(aborted));
  assert(aborted.stopReference && (await absent(aborted.stopReference.containerName)));
  await stable(first.dir);
  const before = await readFile(path.join(other.dir, "heartbeat.txt"), "utf8");
  await delay(200);
  assert.notEqual(
    await readFile(path.join(other.dir, "heartbeat.txt"), "utf8"),
    before,
    "Cancelling one execution must not kill another",
  );
  other.controller.abort();
  const otherResult = await other.result;
  assert(!otherResult.ok && otherResult.error === "aborted" && otherResult.stopped);
  assert(otherResult.stopReference && (await absent(otherResult.stopReference.containerName)));
  assert.notEqual(aborted.stopReference.executionId, otherResult.stopReference.executionId);
  const timed = await start("timeout", jobId, 2500);
  const timeout = await timed.result;
  assert(!timeout.ok && timeout.error === "timeout" && timeout.stopped, JSON.stringify(timeout));
  assert(timeout.stopReference && (await absent(timeout.stopReference.containerName)));
  await stable(timed.dir);

  // Recover a detached, owned execution. A wrong execution label must never authorize removal.
  const executionId = randomUUID(),
    name = `siteoffer-gen-${executionId}`;
  ownedNames.push(name);
  const detached = await command([
    "run",
    "--detach",
    "--rm",
    "--pull",
    "never",
    "--name",
    name,
    "--label",
    `siteoffer.generation.job=${jobId}`,
    "--label",
    `siteoffer.generation.execution=${executionId}`,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "128m",
    "--cpus",
    "1",
    "--user",
    "1000:1000",
    image,
    "node",
    "-e",
    "setInterval(()=>{},1000)",
  ]);
  assert(detached.closed && detached.code === 0, detached.stderr);
  const ref: SandboxStopReference = {
    executionId,
    jobId,
    containerName: name,
    host: hostname(),
    clientPid: detached.pid,
    clientClosed: true,
    stopped: false,
  };
  assert.equal(await recoverDockerExecution("docker", env, { ...ref, jobId: randomUUID() }), false);
  assert.equal(await absent(name), false);
  assert.equal(await recoverDockerExecution("docker", env, ref), true);
  assert(await absent(name));
  await delay(5200);
  for (const dir of [first.dir, other.dir, timed.dir]) {
    await stable(dir);
    await assert.rejects(readFile(path.join(dir, "late.txt")), { code: "ENOENT" });
  }
  assert.equal(await readFile(authFile, "utf8"), "{}");
  console.log(
    JSON.stringify({
      ok: true,
      mode: "offline-codex-lifecycle",
      realModelCall: false,
      network: "none",
      image,
      abortStopped: true,
      timeoutStopped: true,
      noLateWrites: true,
      distinctExecutionNames: true,
      otherExecutionPreserved: true,
      ownedRecovery: true,
      foreignLabelsRejected: true,
      noOwnedContainersRemain: true,
      dummyAuthUnchanged: true,
    }),
  );
} finally {
  for (const controller of controllers) controller.abort();
  const outcomes = await Promise.allSettled(pending);
  for (const name of ownedNames) {
    assert(/^siteoffer-gen-[a-f0-9-]{36}$/.test(name));
    await command(["rm", "--force", name]);
    assert(await absent(name), "Owned recovery container did not stop; retain diagnostics");
  }
  assert(
    outcomes.every((r) => r.status === "fulfilled" && r.value.stopped),
    "Stop unconfirmed; retain the mounted work directories",
  );
  const resolved = path.resolve(root);
  assert(
    path.dirname(resolved) === path.resolve(tmpdir()) &&
      path.basename(resolved).startsWith("siteoffer-lifecycle-check-"),
  );
  await rm(resolved, { recursive: true, force: true });
}
