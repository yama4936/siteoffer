/** Real PostgreSQL, real pg-boss and two OS workers. Fixtures and mock generation only; no Web server. */
import assert from "node:assert/strict";
import { type ChildProcess, execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { attachDesignImage, requestDesignBuild, reviewDesign, systemClock } from "@siteoffer/core";
import {
  companies,
  type Db,
  designVersions,
  discoveryJobs,
  generationJobs,
  proposalVersions,
  users,
} from "@siteoffer/db";
import { createDiscoveryJob } from "@siteoffer/discovery";
import { normalizeDesignImage } from "@siteoffer/generation/images";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { PgBoss } from "pg-boss";
import sharp from "sharp";
import { QUEUES, stepKeys } from "../src/queues.ts";

const exec = promisify(execFile),
  repo = fileURLToPath(new URL("../../../", import.meta.url)),
  runId = randomUUID();
const name = `siteoffer-pipeline-qa-${runId.slice(0, 8)}`,
  password = randomUUID() + randomUUID();
const evidenceRoot = path.join(repo, ".data/local-run/postgres-pipeline");
const artifactRoot = path.join(evidenceRoot, runId);
const report: Record<string, unknown> = {
  status: "running",
  runId,
  startedAt: new Date().toISOString(),
  realModelCalls: 0,
};
const checks: string[] = [],
  events: { type: string; worker: string; queue?: string; status?: string; pid?: number }[] = [];
const children: ChildProcess[] = [],
  producers: PgBoss[] = [];
let container: string | undefined, pool: pg.Pool | undefined;
async function docker(args: string[], env = process.env) {
  return (
    await exec("docker", args, { env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
}
async function eventually(test: () => Promise<boolean>, label: string, timeout = 90_000) {
  const end = Date.now() + timeout;
  do {
    assert(!events.some((e) => e.type === "fatal" || e.type === "error"), "QA worker reported an error");
    assert(
      children.every((c) => c.exitCode === null && c.signalCode === null),
      "QA worker exited unexpectedly",
    );
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < end);
  throw Error(`Timed out: ${label}`);
}
async function main() {
  container = await docker(
    [
      "run",
      "--detach",
      "--pull=never",
      "--name",
      name,
      "--label",
      `siteoffer.qa.run=${runId}`,
      "--cpus",
      "2",
      "--memory",
      "1g",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,size=768m",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_DB=siteoffer_qa",
      "postgres:17.10-alpine",
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
  );
  assert(/^[0-9a-f]{64}$/.test(container));
  await eventually(
    async () => {
      try {
        return (
          await docker(["exec", container!, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "siteoffer_qa"])
        ).includes("accepting connections");
      } catch {
        return false;
      }
    },
    "PostgreSQL ready",
    20_000,
  );
  const binding = await docker(["port", container, "5432/tcp"]),
    match = binding.match(/^127\.0\.0\.1:(\d+)$/);
  assert(match);
  const connectionString = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${match[1]}/siteoffer_qa`;
  pool = new pg.Pool({
    connectionString,
    max: 6,
    connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=30000",
  });
  const db = drizzle(pool) as unknown as Db;
  await migrate(drizzle(pool), { migrationsFolder: path.join(repo, "packages/db/drizzle") });
  report.serverVersion = (await pool.query("show server_version")).rows[0].server_version;
  const [operator] = await db
    .insert(users)
    .values({
      email: "queue-operator@example.test",
      displayName: "架空のキュー検証",
      passwordHash: "not-a-login",
      role: "ops",
    })
    .returning();
  const actor = { kind: "ops", userId: operator!.id } as const;

  // Allowlist the child environment: neither existing DATABASE_URL nor AI credentials are inherited.
  const childEnv: NodeJS.ProcessEnv = { SITEOFFER_PG_PIPELINE_CHILD: runId, PYTHONUTF8: "1" };
  for (const key of [
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "npm_execpath",
  ])
    if (process.env[key]) childEnv[key] = process.env[key];
  for (const worker of ["A", "B"]) {
    const child = fork(path.join(repo, "apps/worker/test/postgres-pipeline-worker.ts"), [], {
      cwd: repo,
      execArgv: ["--import", "tsx"],
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    children.push(child);
    // Only structured, non-sensitive instrumentation is retained; raw SDK/connection errors are not printed.
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("message", (value) => {
      const event = value as (typeof events)[number];
      events.push(event);
      if (["ready", "finish", "fatal", "error"].includes(event.type)) console.log(JSON.stringify(event));
    });
    child.send({ connectionString, artifactRoot, worker });
    await eventually(
      async () => events.some((e) => e.type === "ready" && e.worker === worker),
      `worker ${worker} ready`,
      30_000,
    );
  }
  report.workerPids = events.filter((e) => e.type === "ready").map((e) => e.pid);
  assert.equal(new Set(report.workerPids as number[]).size, 2);
  for (let i = 0; i < 2; i++) {
    const boss = new PgBoss({ connectionString, max: 3, supervise: false, schedule: false });
    boss.on("error", () => events.push({ type: "error", worker: "producer" }));
    await boss.start();
    producers.push(boss);
  }
  checks.push("Two OS workers and two independent pg-boss producers share only the owned PostgreSQL database");
  const jobs = [];
  for (const keywords of [["あおば印刷"], ["架空精工"]]) {
    const job = await createDiscoveryJob(db, systemClock, { provider: "fixture", criteria: { keywords } });
    assert(job.ok);
    jobs.push(job.value.jobId);
  }
  const lock = await pool.connect();
  try {
    await lock.query("begin");
    await lock.query("select id from discovery_jobs where id=$1 for update", [jobs[0]]);
    const firstPayload = { discoveryJobId: jobs[0]! };
    const receipts = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        producers[i % 2]!.send(QUEUES.discovery, firstPayload, { singletonKey: stepKeys.discovery(firstPayload) }),
      ),
    );
    assert.equal(receipts.filter(Boolean).length, 1, "one pending/active queue job for twelve simultaneous receipts");
    await lock.query("commit");
  } finally {
    await lock.query("rollback");
    lock.release();
  }
  await producers[0]!.send(
    QUEUES.discovery,
    { discoveryJobId: jobs[1]! },
    { singletonKey: stepKeys.discovery({ discoveryJobId: jobs[1]! }) },
  );
  checks.push("Twelve simultaneous sends create one pending/active discovery job while its business row is locked");
  await eventually(async () => (await db.select().from(designVersions)).length === 2, "both image-first design drafts");
  const designs = await db.select().from(designVersions);
  assert(designs.every((d) => d.status === "draft" && d.source === "import"));
  assert.equal((await db.select().from(companies)).length, 2);
  assert.equal((await db.select().from(proposalVersions)).length, 0);
  assert((await db.select().from(generationJobs)).every((j) => j.purpose === "evaluation"));
  checks.push("Collection and diagnosis reach two image drafts without creating HTML or proposal text before approval");
  const image = await normalizeDesignImage(
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#dbe4e8" } })
      .png()
      .toBuffer(),
  );
  for (const design of designs) {
    await attachDesignImage(db, systemClock, actor, design.id, image);
    await reviewDesign(db, systemClock, actor, {
      id: design.id,
      approve: true,
      factsChecked: true,
      rightsChecked: true,
      layoutChecked: true,
      note: "架空の同時実行検証。見た目の品質承認ではありません。",
    });
    await requestDesignBuild(db, systemClock, actor, design.id);
  }
  await eventually(
    async () => {
      const vs = await db.select().from(proposalVersions);
      return vs.length === 2 && vs.every((v) => v.status === "in_review");
    },
    "reviewable proposal sites",
    150_000,
  );
  const versions = await db.select().from(proposalVersions),
    generated = await db.select().from(generationJobs);
  assert.equal(generated.length, 10, "one evaluation plus four production purposes for each company");
  assert(generated.every((j) => j.status === "succeeded" && j.generator === "mock"));
  for (const version of versions) {
    const content = version.content as { designVersionId?: string; demoCheck?: { ok: boolean }; demoRef?: string };
    assert(designs.some((d) => d.id === content.designVersionId));
    assert(content.demoCheck?.ok);
    assert(version.demoArtifactDir);
    const file = path.resolve(version.demoArtifactDir, "index.html");
    assert(file.startsWith(path.resolve(artifactRoot) + path.sep));
    assert((await readFile(file, "utf8")).includes("<!DOCTYPE html>"), "real Astro HTML was built");
  }
  checks.push(
    "After explicit image approval, both workers produce reviewable proposals and real Astro HTML for the pinned images",
  );
  for (const design of designs) {
    const payload = {
      companyId: design.companyId,
      auditId: design.auditId,
      designVersionId: design.id,
      revision: `design:${design.id}`,
    };
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        producers[i % 2]!.send(QUEUES.proposal, payload, { singletonKey: stepKeys.proposal(payload) }),
      ),
    );
  }
  await eventually(
    async () =>
      (
        await pool!.query(
          "select count(*)::int n from pgboss.job where name in ($1,$2,$3) and state in ('created','retry','active')",
          [QUEUES.discovery, QUEUES.audit, QUEUES.proposal],
        )
      ).rows[0].n === 0,
    "duplicate receipts drained",
  );
  assert.equal((await db.select().from(proposalVersions)).length, 2);
  assert.equal((await db.select().from(generationJobs)).length, 10);
  assert(
    (
      await db
        .select()
        .from(discoveryJobs)
        .where(and(eq(discoveryJobs.status, "succeeded"), eq(discoveryJobs.provider, "fixture")))
    ).length === 2,
  );
  assert.equal(
    new Set(events.filter((e) => e.type === "finish" && e.queue?.startsWith("pipeline.")).map((e) => e.worker)).size,
    2,
  );
  checks.push(
    "Late duplicate receipts drain without extra versions or generation calls, and both OS workers execute pipeline jobs",
  );
  report.status = "passed";
}
await mkdir(artifactRoot, { recursive: true });
try {
  await main();
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message.replaceAll(password, "[redacted]") : "QA failure";
  process.exitCode = 1;
} finally {
  await Promise.allSettled(producers.map((b) => b.stop({ graceful: true, timeout: 10_000 })));
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      if (child.connected) child.send("stop");
      const timer = setTimeout(() => {
        child.kill();
        report.workerForcedStop = true;
        report.status = "failed";
        process.exitCode = 1;
      }, 25_000);
      await ended;
      clearTimeout(timer);
      if (child.exitCode !== 0) {
        report.status = "failed";
        process.exitCode = 1;
      }
    }),
  );
  await pool?.end();
  if (container) {
    try {
      assert.equal(
        await docker(["inspect", "--format", '{{index .Config.Labels "siteoffer.qa.run"}}', container]),
        runId,
      );
      await docker(["rm", "--force", container]);
      report.containerRemoved = true;
    } catch {
      report.status = "failed";
      report.cleanupFailed = true;
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  report.checks = checks;
  report.events = events;
  await writeFile(path.join(artifactRoot, "result.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(evidenceRoot, "latest-result.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      status: report.status,
      checks: checks.length,
      error: report.error,
      containerRemoved: report.containerRemoved,
    }),
  );
}
