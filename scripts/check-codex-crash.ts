import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixedClock } from "../packages/core/src/common/clock.ts";
import { generationJobs } from "../packages/db/src/schema/index.ts";
import { createTestDb } from "../packages/db/src/testing.ts";
import { CodexGenerator } from "../packages/generation/src/codex.ts";
import { runGenerationJob } from "../packages/generation/src/jobs.ts";
import { GENERATION_LEASE_MS, recoverExpiredGenerationJobs } from "../packages/generation/src/lease.ts";
import { buildDockerClientEnv, DockerSandboxRunner } from "../packages/generation/src/sandbox/docker.ts";
import { runDockerCommand } from "../packages/generation/src/sandbox/docker-process.ts";
import { type SandboxStopReference, sandboxStopReferenceSchema } from "../packages/generation/src/sandbox/types.ts";
import { recoverUnconfirmedGenerationJobs } from "../packages/generation/src/stop-recovery.ts";
import type { Generator } from "../packages/generation/src/types.ts";
import { fixtureInput } from "../packages/generation/test/helpers.ts";

// Kill only our producer, reopen its isolated on-disk PGlite, and recover through the normal job APIs.
// No SDK turn, real credentials, application database or web server.
const root = await mkdtemp(path.join(tmpdir(), "siteoffer-crash-check-"));
const workRoot = path.join(root, "work"),
  referenceFile = path.join(root, "host-reference.json");
const workDirFile = path.join(root, "work-directory.txt"),
  dataDir = path.join(root, "database");
const jobKey = `offline-crash-${randomUUID()}`,
  image = process.env.SITEOFFER_CODEX_IMAGE || "siteoffer-codex:local";
const fixtureTime = "2026-10-18T15:00:00Z";
let jobId = "",
  workDir = "",
  reopened: Awaited<ReturnType<typeof createTestDb>> | undefined;
const env = buildDockerClientEnv(process.env);
const command = (args: string[]) => runDockerCommand("docker", args, env, 10_000, undefined, undefined, true);
let producer: ReturnType<typeof spawn> | undefined, producerClosed: Promise<void> | undefined;
let reference: SandboxStopReference | undefined,
  stopped = false;
async function waitFor<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await delay(25);
  }
  throw new Error(`Offline crash check timed out: ${label}`);
}
async function readReference() {
  try {
    const parsed = sandboxStopReferenceSchema.safeParse(JSON.parse(await readFile(referenceFile, "utf8")));
    return parsed.success && (!jobId || parsed.data.jobId === jobId) ? parsed.data : null;
  } catch {
    return null;
  }
}
async function absent(name: string) {
  const result = await command(["inspect", "--type", "container", name]);
  return result.closed && result.code === 1 && /No such (container|object)/i.test(result.stderr);
}
async function removeOwned(ref: SandboxStopReference) {
  const result = await command([
    "inspect",
    "--type",
    "container",
    "--format",
    "{{json .Config.Labels}}",
    ref.containerName,
  ]);
  if (result.code === 1 && /No such (container|object)/i.test(result.stderr)) return;
  assert(result.closed && result.code === 0, "Cannot inspect the offline container; retain its work directory");
  const labels = JSON.parse(result.stdout);
  assert.equal(labels["siteoffer.generation.job"], jobId);
  assert.equal(labels["siteoffer.generation.execution"], ref.executionId);
  await command(["rm", "--force", ref.containerName]);
}
try {
  await mkdir(workRoot);
  await writeFile(path.join(root, "dummy-auth.json"), "{}");
  const runnerModule = new URL("../packages/generation/src/sandbox/docker.ts", import.meta.url).href;
  const modules = Object.fromEntries(
    Object.entries({
      db: "../packages/db/src/testing.ts",
      clock: "../packages/core/src/common/clock.ts",
      jobs: "../packages/generation/src/jobs.ts",
      generator: "../packages/generation/src/codex.ts",
      input: "../packages/generation/test/helpers.ts",
    }).map(([name, relative]) => [name, new URL(relative, import.meta.url).href]),
  );
  await writeFile(
    path.join(root, "producer.mjs"),
    `
import {writeFile} from 'node:fs/promises';
const {DockerSandboxRunner}=await import(${JSON.stringify(runnerModule)});
const {createTestDb}=await import(${JSON.stringify(modules.db)});
const {fixedClock}=await import(${JSON.stringify(modules.clock)});
const {runGenerationJob}=await import(${JSON.stringify(modules.jobs)});
const {CodexGenerator}=await import(${JSON.stringify(modules.generator)});
const {fixtureInput}=await import(${JSON.stringify(modules.input)});
const database=await createTestDb({dataDir:${JSON.stringify(dataDir)}});
const runner=new DockerSandboxRunner({image:${JSON.stringify(image)},network:'none',codexAuthFile:${JSON.stringify(path.join(root, "dummy-auth.json"))},entryCommand:['node','-e',"let n=0;setInterval(()=>require('node:fs').writeFileSync('/work/heartbeat.txt',String(++n)),50);setTimeout(()=>process.exit(0),120000)"]});
const generator=new CodexGenerator({kind:'offline',recoverStop:ref=>runner.recoverStop(ref),run:async(spec)=>{
await writeFile(${JSON.stringify(workDirFile)},spec.workDir);
return runner.run({...spec,saveStopReference:async(ref)=>{await spec.saveStopReference(ref);await writeFile(${JSON.stringify(referenceFile)},JSON.stringify(ref));}});
}},{workRoot:${JSON.stringify(workRoot)}});
await runGenerationJob({db:database.db,clock:fixedClock(${JSON.stringify(fixtureTime)}),generator,limits:{timeoutMs:60000,maxAttempts:1}},
{idempotencyKey:${JSON.stringify(jobKey)},companyId:null,purpose:'faq',input:fixtureInput()});
await database.close();
`,
  );
  producer = spawn(process.execPath, ["--import", "tsx", path.join(root, "producer.mjs")], {
    cwd: process.cwd(),
    env,
    stdio: "ignore",
    windowsHide: true,
  });
  producerClosed = new Promise<void>((resolve) => {
    producer!.once("close", () => resolve());
    producer!.once("error", () => resolve());
  });
  reference = await waitFor(async () => {
    const ref = await readReference();
    return ref?.clientPid ? ref : null;
  }, "PID persistence");
  jobId = reference.jobId;
  workDir = (await readFile(workDirFile, "utf8")).trim();
  assert(path.resolve(workDir).startsWith(path.resolve(workRoot) + path.sep));
  assert(path.basename(workDir).startsWith(`${jobId}-1-`));
  await waitFor(() => readFile(path.join(workDir, "heartbeat.txt"), "utf8").catch(() => null), "container heartbeat");
  assert.equal(reference.clientClosed, false);
  assert.equal(reference.stopped, false);
  producer.kill("SIGTERM");
  await waitFor(
    async () => (producer!.exitCode !== null || producer!.signalCode !== null ? true : null),
    "producer termination",
  );
  await producerClosed;
  assert.equal(
    (await readReference())?.executionId,
    reference.executionId,
    "The host reference must survive producer termination",
  );
  const orphanWasPresent = !(await absent(reference.containerName));
  if (orphanWasPresent) {
    const before = await readFile(path.join(workDir, "heartbeat.txt"), "utf8");
    await delay(200);
    assert.notEqual(await readFile(path.join(workDir, "heartbeat.txt"), "utf8"), before);
  }
  reopened = await createTestDb({ dataDir });
  const persisted = (await reopened.db.select().from(generationJobs)).find((r) => r.id === jobId);
  assert.equal(persisted?.idempotencyKey, jobKey);
  assert.equal(
    (persisted?.outputRef as { stopReference?: SandboxStopReference })?.stopReference?.executionId,
    reference.executionId,
  );
  assert.equal(persisted?.status, "running");
  const clock = fixedClock(fixtureTime);
  clock.advance(GENERATION_LEASE_MS + 1);
  let calls = 0;
  const guard: Generator = {
    kind: "codex",
    requestedModel: null,
    promptVersion: () => "offline",
    generate: async () => {
      calls++;
      throw Error("An offline crash check must not call a model");
    },
  };
  const admission = await runGenerationJob(
    { db: reopened.db, clock, generator: guard },
    { idempotencyKey: `${jobKey}:blocked`, companyId: null, purpose: "faq", input: fixtureInput() },
  );
  assert(!admission.ok && admission.error === "sandbox_stop_pending");
  assert.equal(calls, 0);
  assert.deepEqual(await recoverExpiredGenerationJobs(reopened.db, clock), [jobId]);
  const recoveryGenerator = new CodexGenerator(
    new DockerSandboxRunner({ image, network: "none", codexAuthFile: path.join(root, "dummy-auth.json") }),
  );
  const deps = { db: reopened.db, clock, generator: recoveryGenerator };
  let recovered = await recoverUnconfirmedGenerationJobs(deps);
  const requiredFixtureCleanup = !recovered.includes(jobId);
  if (requiredFixtureCleanup) {
    // A live client is intentionally not killed by PID. The fixture owner stops its verified container.
    await removeOwned(reference);
    await waitFor(async () => {
      try {
        process.kill(reference!.clientPid!, 0);
        return null;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH" ? true : null;
      }
    }, "Docker client termination");
    recovered = await recoverUnconfirmedGenerationJobs(deps);
  }
  assert(recovered.includes(jobId), "A live or unverified client must not be treated as stopped");
  const closed = (await reopened.db.select().from(generationJobs)).find((r) => r.id === jobId);
  assert.equal(closed?.errorCode, "sandbox_stop_confirmed");
  assert.equal(closed?.output, null);
  assert(await absent(reference.containerName));
  stopped = true;
  const before = await readFile(path.join(workDir, "heartbeat.txt"), "utf8");
  await delay(250);
  assert.equal(await readFile(path.join(workDir, "heartbeat.txt"), "utf8"), before);
  assert.equal(await readFile(path.join(root, "dummy-auth.json"), "utf8"), "{}");
  console.log(
    JSON.stringify({
      ok: true,
      mode: "offline-producer-crash",
      realModelCall: false,
      network: "none",
      producerTerminated: true,
      hostReferenceSurvived: true,
      durableJobReferenceSurvived: true,
      newGenerationFencedBeforeSweep: true,
      lateOutputAdopted: false,
      modelCalls: calls,
      pidRecordedBeforeCrash: true,
      orphanWasPresent,
      requiredFixtureCleanup,
      recoveryConfirmed: true,
      writesStopped: true,
      ownedContainerAbsent: true,
    }),
  );
} finally {
  if (producer && producer.exitCode === null && producer.signalCode === null) {
    producer.kill("SIGKILL");
    await producerClosed;
  }
  reference ??= (await readReference()) ?? undefined;
  if (reference && !stopped) await removeOwned(reference);
  await reopened?.close();
  const resolved = path.resolve(root);
  assert(
    path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith("siteoffer-crash-check-"),
  );
  if (stopped) await rm(resolved, { recursive: true, force: true });
}
