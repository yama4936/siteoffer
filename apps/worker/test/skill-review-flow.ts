/**
 * Isolated T27 QA: PostgreSQL 17.10 + production pg-boss/runtime + fixture skill executor + real Web.
 * Run: pnpm test:postgres:skill-review in a fresh checkout without root/app dotenv files.
 * Requires installed dependencies, local Docker and the cached postgres:17.10-alpine image (--pull=never).
 * At awaiting_skill, log in with the private QA account and start site evaluation with chaining at /ops/skills.
 * At awaiting_browser, compare the generated reviewUrl and approve the proposal in the browser.
 * Read private-access.json locally without printing its contents. Browser automation writes
 * {"action":"finish"} to control.json after screenshots; {"action":"abort"} stops with failure.
 * Synthetic skill outputs/quality PNGs do not prove real Codex generation or visual quality.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFile, fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { systemClock } from "@siteoffer/core";
import { createUserBySystem, generatePassword } from "@siteoffer/core/auth";
import {
  auditEvents,
  companies,
  type Db,
  productTerms,
  proposalVersions,
  salesOffers,
  skillRuns,
  users,
  websites,
} from "@siteoffer/db";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const runId = randomUUID();
const evidenceRoot = path.join(repo, ".data/local-run/skill-review-flow");
const artifactRoot = path.join(evidenceRoot, runId);
const name = `siteoffer-skill-review-qa-${runId.slice(0, 8)}`;
const password = randomUUID() + randomUUID();
const loginPassword = generatePassword();
const checks: string[] = [];
type Event = {
  type: string;
  worker: string;
  queue?: string;
  skill?: string;
  runId?: string;
  status?: string;
  pid?: number;
};
const events: Event[] = [];
const children: ChildProcess[] = [];
const childErrors: { stage: string; code: string }[] = [];
const report: Record<string, unknown> = {
  status: "starting",
  runId,
  startedAt: new Date().toISOString(),
  realModelCalls: 0,
  skillExecutor: "qa-fixture-no-model",
  dependencyInjection: "test-only deps.skills; production mock configuration unchanged",
  heartbeatSkillRunner: "fixture; test-only dependency injection, no Codex SDK execution",
  qualityEvidence: "synthetic regression PNGs; not a visual quality assessment",
  childErrors,
};
let container: string | undefined;
let pool: pg.Pool | undefined;
let web: ChildProcess | undefined;
let webLog: WriteStream | undefined;
let privateHome: string | undefined;
let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
});
process.once("SIGTERM", () => {
  interrupted = true;
});

// No inherited HOME, DATABASE_URL, NODE_OPTIONS, API keys, auth files, proxies or cloud credentials.
const childEnv: NodeJS.ProcessEnv = {
  PYTHONUTF8: "1",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NEXT_TELEMETRY_DISABLED: "1",
};
for (const key of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"])
  if (process.env[key]) childEnv[key] = process.env[key];
async function docker(args: string[], extra: NodeJS.ProcessEnv = {}) {
  return (
    await exec("docker", args, { env: { ...childEnv, ...extra }, timeout: 30_000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
}
async function eventually(test: () => Promise<boolean>, label: string, timeout = 120_000) {
  const end = Date.now() + timeout;
  do {
    assert(!interrupted, "QA interrupted");
    assert(!events.some((event) => event.type === "error" || event.type === "fatal"), "QA worker reported an error");
    assert(
      children.every((child) => child.exitCode === null && child.signalCode === null),
      "QA worker exited unexpectedly",
    );
    assert(!web || (web.exitCode === null && web.signalCode === null), "QA Web exited unexpectedly");
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < end);
  throw Error(`Timed out: ${label}`);
}
async function loopbackPort() {
  const reservation = createServer();
  return new Promise<number>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const port = (reservation.address() as AddressInfo).port;
      reservation.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
async function state(extra: Record<string, unknown> = {}) {
  const value = { ...report, artifactRoot, checks, events, ...extra };
  await writeFile(path.join(artifactRoot, "state.json"), JSON.stringify(value, null, 2));
  await writeFile(path.join(evidenceRoot, "latest-state.json"), JSON.stringify(value, null, 2));
}
function childError(stage: string, error: Error) {
  const rawCode = (error as NodeJS.ErrnoException).code;
  const code = typeof rawCode === "string" && /^[A-Z0-9_]{1,40}$/.test(rawCode) ? rawCode : "PROCESS_ERROR";
  childErrors.push({ stage, code });
  events.push({ type: "error", worker: stage });
}
async function stopChild(child: ChildProcess, worker: boolean) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (worker && child.connected) child.send("stop");
  else child.kill("SIGTERM");
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    report.forcedStop = true;
    process.exitCode = 1;
  }, 25_000);
  await ended;
  clearTimeout(timer);
}
async function main() {
  // Next has its own dotenv loader; reject app-local files rather than silently reading credentials.
  assert(!existsSync(path.join(repo, ".env")), "Root dotenv must be absent for isolated QA");
  for (const envFile of [".env", ".env.local", ".env.development", ".env.development.local"])
    assert(!existsSync(path.join(repo, "apps/web", envFile)), "App-local dotenv must be absent for isolated QA");
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
    { POSTGRES_PASSWORD: password },
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
    30_000,
  );
  const match = (await docker(["port", container, "5432/tcp"])).match(/^127\.0\.0\.1:(\d+)$/);
  assert(match);
  const connectionString = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${match[1]}/siteoffer_qa`;
  pool = new pg.Pool({
    connectionString,
    max: 6,
    connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=30000",
  });
  pool.on("error", () => events.push({ type: "error", worker: "admin" }));
  const db = drizzle(pool) as unknown as Db;
  await migrate(drizzle(pool), { migrationsFolder: path.join(repo, "packages/db/drizzle") });
  report.serverVersion = (await pool.query("show server_version")).rows[0].server_version;
  const created = await createUserBySystem(db, systemClock, {
    email: "skill-review-ops@example.test",
    displayName: "通し検証用の運営",
    password: loginPassword,
    role: "ops",
    job: "qa:skill-review-flow",
  });
  assert(created.ok, "QA operator creation failed");
  const [operator] = await db.select().from(users).where(eq(users.email, "skill-review-ops@example.test"));
  assert(operator);
  const [terms] = await db
    .insert(productTerms)
    .values({
      version: `qa-skill-review-${runId.slice(0, 8)}`,
      name: "専用DB検証の仮条件（実販売用ではありません）",
      scope: { _note: "Synthetic QA fixture only", pages: ["company"] },
      price: 300_000,
      monthlyFee: 5_000,
      rewardRule: { type: "rate", basisPoints: 1000 },
    })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "株式会社例", officialSiteStatus: "confirmed", pipelineStatus: "site_confirmed" })
    .returning();
  assert(company && terms);
  await db.insert(websites).values({
    companyId: company.id,
    url: "https://kakuu-koumuten.example/",
    normalizedUrl: "kakuu-koumuten.example/",
    domain: "kakuu-koumuten.example",
    kind: "current",
    isPrimary: true,
  });
  report.companyId = company.id;
  report.productTermsId = terms.id;
  report.databasePort = Number(match[1]);
  for (const worker of ["A", "B"]) {
    const child = fork(path.join(repo, "apps/worker/test/skill-review-flow-worker.ts"), [], {
      cwd: repo,
      execArgv: ["--import", "tsx"],
      env: { ...childEnv, HOME: privateHome, SITEOFFER_SKILL_REVIEW_CHILD: runId },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    child.on("error", (error) => childError(`worker_${worker}_process`, error));
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("message", (raw) => {
      events.push(raw as Event);
    });
    child.send({ connectionString, artifactRoot, repoRoot: repo, worker });
    await eventually(
      async () => events.some((event) => event.type === "ready" && event.worker === worker),
      `worker ${worker} ready`,
      45_000,
    );
  }
  report.workerPids = events.filter((event) => event.type === "ready").map((event) => event.pid);
  checks.push(
    "Dedicated loopback PostgreSQL and two OS workers use production pg-boss, intake and runtime; only skill output is mocked",
  );
  const port = await loopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const next = path.join(repo, "apps/web/node_modules/next/dist/bin/next");
  assert(existsSync(next), "Install Web dependencies before running QA");
  // Private local diagnostics only. Raw Next exceptions/requests never enter public state or stdout.
  webLog = createWriteStream(path.join(artifactRoot, "private-web.log"), { flags: "wx", mode: 0o600 });
  webLog.on("error", (error) => childError("web_private_log", error));
  web = spawn(process.execPath, [next, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(repo, "apps/web"),
    env: {
      ...childEnv,
      HOME: privateHome,
      DATABASE_URL: connectionString,
      SITEOFFER_NEXT_DIST_DIR: `.next-quality/skill-review-flow-${runId.slice(0, 8)}`,
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  web.on("error", (error) => childError("web_process", error));
  web.stdout?.pipe(webLog, { end: false });
  web.stderr?.pipe(webLog, { end: false });
  await eventually(
    async () => {
      try {
        return (await fetch(`${origin}/login`, { signal: AbortSignal.timeout(5000) })).status === 200;
      } catch {
        return false;
      }
    },
    "QA Web login",
    180_000,
  );
  report.webPid = web.pid;
  report.origin = origin;
  report.skillUrl = `${origin}/ops/skills`;
  report.status = "awaiting_skill";
  await writeFile(
    path.join(artifactRoot, "private-access.json"),
    JSON.stringify({ origin, email: operator.email, password: loginPassword, connectionString }, null, 2),
    { mode: 0o600 },
  );
  await state();
  console.log(
    JSON.stringify({
      status: report.status,
      artifactRoot,
      origin,
      skillUrl: report.skillUrl,
      privateAccessFile: path.join(artifactRoot, "private-access.json"),
      controlFile: path.join(artifactRoot, "control.json"),
    }),
  );
  await eventually(
    async () => {
      const runs = await db.select().from(skillRuns);
      assert(
        runs.every((run) => run.status !== "failed"),
        "Fixture skill run failed",
      );
      const versions = await db.select().from(proposalVersions);
      return (
        runs.length === 3 &&
        runs.every((run) => run.status === "succeeded") &&
        versions.length === 1 &&
        versions[0]?.status === "in_review"
      );
    },
    "browser skill request, chain and AI precheck",
    15 * 60_000,
  );
  const [version] = await db.select().from(proposalVersions);
  assert(version);
  const aiCheck = (version.content as { aiCheck?: { status: string; items: { ok: boolean }[] } }).aiCheck;
  assert(aiCheck?.status === "passed" && aiCheck.items.length === 4 && aiCheck.items.every((item) => item.ok));
  assert.equal((await db.select().from(companies).where(eq(companies.id, company.id)))[0]?.pipelineStatus, "in_review");
  assert.equal((await db.select().from(salesOffers)).length, 0);
  const runs = await db.select().from(skillRuns);
  assert.deepEqual(runs.map((run) => run.skill).sort(), ["site-evaluation", "site-proposal", "site-rebuild"]);
  const first = runs.find((run) => run.skill === "site-evaluation");
  assert(first?.trigger === "manual" && first.createdBy === operator.id && first.parentRunId === null);
  assert(runs.filter((run) => run.trigger === "chain" && run.parentRunId !== null).length === 2);
  report.firstSkillRunId = first.id;
  assert.equal(events.filter((event) => event.type === "fixture_execution").length, 3);
  report.proposalVersionId = version.id;
  report.skillRuns = runs.map((run) => ({
    id: run.id,
    skill: run.skill,
    status: run.status,
    parentRunId: run.parentRunId,
  }));
  report.aiCheck = aiCheck;
  checks.push(
    "One browser-requested evaluation automatically chains proposal and rebuild, runs real Python prechecks and creates one passed in_review version without intermediate approval",
  );
  report.reviewUrl = `${origin}/ops/review?company=${company.id}&version=${version.id}`;
  report.status = "awaiting_browser";
  await state();
  console.log(JSON.stringify({ status: report.status, artifactRoot, origin, reviewUrl: report.reviewUrl }));
  await eventually(
    async () => {
      try {
        const control = JSON.parse(await readFile(path.join(artifactRoot, "control.json"), "utf8"));
        assert(control.action !== "abort", "Browser verification aborted");
        return control.action === "finish";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    "browser verification control file",
    15 * 60_000,
  );
  const [finalVersion] = await db.select().from(proposalVersions).where(eq(proposalVersions.id, version.id));
  const [finalCompany] = await db.select().from(companies).where(eq(companies.id, company.id));
  const offers = await db.select().from(salesOffers);
  assert.equal(finalVersion?.status, "approved", "Browser must approve the version");
  assert.equal(finalCompany?.pipelineStatus, "sellable", "Approval must make the candidate sellable");
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.proposalVersionId, version.id);
  assert.equal(offers[0]?.productTermsId, terms.id);
  assert.equal(offers[0]?.isPublic, true);
  const protectedCounts = await db.execute(
    sql`select (select count(*)::int from contracts) contracts,(select count(*)::int from payments) payments,(select count(*)::int from rewards) rewards`,
  );
  assert.deepEqual((protectedCounts as { rows: unknown[] }).rows[0], { contracts: 0, payments: 0, rewards: 0 });
  report.final = {
    proposalStatus: finalVersion.status,
    companyStatus: finalCompany.pipelineStatus,
    salesOfferId: offers[0]!.id,
    protectedCounts: (protectedCounts as { rows: unknown[] }).rows[0],
  };
  report.auditActions = (await db.select({ action: auditEvents.action }).from(auditEvents)).map(
    (event) => event.action,
  );
  checks.push(
    "Browser approval persisted approved + sellable and one public sales offer for the exact proposal and synthetic terms; contracts/payments/rewards remain empty",
  );
  report.status = "passed";
}
await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
try {
  privateHome = await mkdtemp(path.join(os.tmpdir(), "siteoffer-skill-review-home-"));
  await main();
} catch (error) {
  report.status = "failed";
  if (pool) {
    try {
      const snapshot = await pool.query("select id,skill,status,error,result from skill_runs order by created_at,id");
      await writeFile(path.join(artifactRoot, "private-db-failure.json"), JSON.stringify(snapshot.rows, null, 2), {
        mode: 0o600,
      });
      report.privateFailureSnapshotSaved = true;
    } catch {
      report.privateFailureSnapshotSaved = false;
    }
  }
  // Never include arbitrary driver/SDK errors or shell stderr in the public QA report.
  report.error =
    error instanceof assert.AssertionError ||
    (error instanceof Error && /^(Timed out:|QA |Browser )/.test(error.message))
      ? error.message.replaceAll(password, "[redacted]").replaceAll(loginPassword, "[redacted]")
      : "QA failed; inspect owned processes without printing credentials";
  process.exitCode = 1;
} finally {
  if (web) await stopChild(web, false);
  if (webLog && !webLog.destroyed) {
    const log = webLog;
    await new Promise<void>((resolve) => log.end(resolve));
  }
  await Promise.all(children.map((child) => stopChild(child, true)));
  if (privateHome) {
    try {
      await rm(privateHome, { recursive: true, force: true });
      report.privateHomeRemoved = true;
    } catch {
      report.cleanupFailed = true;
      process.exitCode = 1;
    }
  }
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
      report.cleanupFailed = true;
      process.exitCode = 1;
    }
  }
  if (report.forcedStop || report.cleanupFailed) report.status = "failed";
  report.finishedAt = new Date().toISOString();
  await state();
  console.log(
    JSON.stringify({
      status: report.status,
      checks: checks.length,
      error: report.error,
      containerRemoved: report.containerRemoved,
    }),
  );
}
