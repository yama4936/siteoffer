/** 独立したDocker/PostgreSQLだけを使う統合検査。既存のDATABASE_URLは使用しない。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { systemClock } from "@siteoffer/core";
import { auditEvents, auditRequests, companies, type Db, users, websites } from "@siteoffer/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { listAuditPreparation, requestPreparedAudits } from "../src/audit-preparation.ts";
import { getAuditAttentionWork } from "../src/audit-recovery.ts";
import { auditRequestKey, requestAuditByOps, validateAuditRequest } from "../src/audit-request.ts";
import { cancelAuditRequest, listAuditRequests } from "../src/audit-request-management.ts";
import { claimStep } from "../src/ledger.ts";
import { QUEUES } from "../src/queues.ts";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const runId = randomUUID();
const name = `siteoffer-audit-qa-${runId.slice(0, 8)}`;
const password = randomUUID() + randomUUID();
const image = process.env.SITEOFFER_PG_QA_IMAGE ?? "postgres:17.10-alpine";
const output = path.join(repo, ".data/local-run/postgres-audits-result.json");
const pools: pg.Pool[] = [];
let container: string | undefined;
const checks: string[] = [];
const report: Record<string, unknown> = { status: "running", startedAt: new Date().toISOString(), image, checks };
async function docker(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return (await exec("docker", args, { env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function eventually(check: () => Promise<boolean>, label: string, timeout = 4000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  } while (Date.now() < deadline);
  throw Error(`Timed out: ${label}`);
}
async function seed(db: Db, title: string) {
  const [c] = await db
    .insert(companies)
    .values({ name: `架空PG検証・${title}`, officialSiteStatus: "confirmed", pipelineStatus: "failed" })
    .returning();
  const [w] = await db
    .insert(websites)
    .values({
      companyId: c!.id,
      url: `https://${c!.id}.example/`,
      normalizedUrl: `${c!.id}.example`,
      domain: `${c!.id}.example`,
      kind: "current",
      isPrimary: true,
    })
    .returning();
  return { company: c!, website: w! };
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
      image,
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
  );
  assert(/^[0-9a-f]{64}$/.test(container));
  report.containerName = name;
  console.log(`Created isolated PostgreSQL container: ${name}`);
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
    20000,
  );
  const binding = await docker(["port", container, "5432/tcp"]);
  const match = binding.match(/^127\.0\.0\.1:(\d+)$/);
  assert(match, "loopback binding");
  const connectionString = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${match[1]}/siteoffer_qa`;
  const peers = Array.from({ length: 6 }, (_, i) => {
    const pool = new pg.Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 5000,
      application_name: `siteoffer-qa-${i}`,
      options: "-c statement_timeout=20000 -c lock_timeout=5000",
    });
    pools.push(pool);
    return { pool, db: drizzle(pool) as unknown as Db };
  });
  const admin = peers[0]!;
  await migrate(drizzle(admin.pool), { migrationsFolder: path.join(repo, "packages/db/drizzle") });
  report.serverVersion = (await admin.pool.query("show server_version")).rows[0].server_version;
  const pids = await Promise.all(
    peers.map((p) => p.pool.query("select pg_backend_pid() as pid").then((r) => r.rows[0].pid)),
  );
  assert.equal(new Set(pids).size, 6);
  report.independentBackends = 6;
  const ops = await Promise.all(
    peers.map(async (p, i) => {
      const [u] = await p.db
        .insert(users)
        .values({ email: `pg-${i}@example.test`, passwordHash: "fixture", displayName: `PG担当${i}`, role: "ops" })
        .returning();
      return { kind: "ops", userId: u!.id } as const;
    }),
  );
  const c = await seed(admin.db, "同時受付");
  const operations = Array.from({ length: 18 }, () => randomUUID());
  const receipts = await Promise.all(
    operations.map((requestId, i) =>
      requestAuditByOps(peers[i % 6]!.db, systemClock, ops[i % 6]!, { companyId: c.company.id, requestId }),
    ),
  );
  assert(receipts.every((r) => r.ok));
  const receiptIds = receipts.map((r) => (r.ok ? r.value.requestId : ""));
  assert.equal(new Set(receiptIds).size, 1);
  assert.equal(
    (await admin.db.select().from(auditRequests).where(eq(auditRequests.companyId, c.company.id))).length,
    1,
  );
  checks.push("18 simultaneous requests over 6 connections yield one request");
  console.log("PASS concurrent intake");
  const id = receiptIds[0]!;
  const cancellations = await Promise.all(peers.map((p, i) => cancelAuditRequest(p.db, systemClock, ops[i]!, id)));
  assert(cancellations.every((r) => r.ok));
  assert.equal(cancellations.filter((r) => r.ok && !r.value.alreadyCancelled).length, 1);
  assert.equal(
    (
      await admin.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.targetId, c.company.id), eq(auditEvents.action, "audit.request_cancelled")))
    ).length,
    1,
  );
  const repeated = await Promise.all(
    operations.map((requestId, i) =>
      requestAuditByOps(peers[i % 6]!.db, systemClock, ops[i % 6]!, { companyId: c.company.id, requestId }),
    ),
  );
  assert(repeated.every((r) => r.ok && r.value.requestId === id && r.value.alreadyAccepted));
  checks.push("6 concurrent cancellations commit once; 18 late receipts still identify the cancelled request");
  const actor = { kind: "system", job: "pg-qa" } as const;
  async function waiting(peerIndex: number) {
    return (
      Number(
        (
          await admin.pool.query(
            "select count(*)::int n from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
            [`siteoffer-qa-${peerIndex}`],
          )
        ).rows[0].n,
      ) > 0
    );
  }
  for (const winner of ["cancel", "start"] as const) {
    const s = await seed(admin.db, `lock-${winner}`);
    const requestId = randomUUID();
    assert((await requestAuditByOps(admin.db, systemClock, ops[0]!, { companyId: s.company.id, requestId })).ok);
    const key = auditRequestKey({ id: requestId, companyId: s.company.id });
    const entered = deferred(),
      release = deferred();
    const held = peers[1]!.db.transaction(async (tx) => {
      const r =
        winner === "cancel"
          ? await cancelAuditRequest(tx, systemClock, ops[1]!, requestId)
          : await claimStep(tx, systemClock, { key, queue: QUEUES.audit, maxAttempts: 3, staleAfterMs: 60000, actor });
      entered.resolve();
      await release.promise;
      return r;
    });
    await Promise.race([
      entered.promise,
      held.then(() => {
        throw Error("Lock holder exited before signalling");
      }),
    ]);
    const follower =
      winner === "cancel"
        ? claimStep(peers[2]!.db, systemClock, { key, queue: QUEUES.audit, maxAttempts: 3, staleAfterMs: 60000, actor })
        : cancelAuditRequest(peers[2]!.db, systemClock, ops[2]!, requestId);
    void follower.catch(() => {});
    try {
      await eventually(() => waiting(2), `${winner} lock observed`);
    } finally {
      release.resolve();
      await Promise.allSettled([held, follower]);
    }
    await held;
    const result = await follower;
    if (winner === "cancel") {
      assert("kind" in result && result.kind === "claimed");
      assert.match(
        (await validateAuditRequest(peers[2]!.db, { companyId: s.company.id, requestKey: `ops:${requestId}` }))!,
        /終了済み/,
      );
      assert.equal(
        (await admin.db.select().from(auditRequests).where(eq(auditRequests.id, requestId)))[0]!.status,
        "cancelled",
      );
    } else assert("ok" in result && !result.ok && result.error === "already_started");
    checks.push(`${winner} wins while other connection observably waits on a PostgreSQL lock`);
    console.log(`PASS ${winner === "cancel" ? "cancel before start" : "start before cancel"} lock boundary`);
  }
  // isAuditOperatorの先行読み取り後に利用停止が確定しても、更新時の行ロックで拒否する。
  const s = await seed(admin.db, "利用停止");
  const requestId = randomUUID();
  assert((await requestAuditByOps(admin.db, systemClock, ops[0]!, { companyId: s.company.id, requestId })).ok);
  const entered = deferred(),
    release = deferred();
  const suspension = peers[3]!.db.transaction(async (tx) => {
    await tx.update(users).set({ status: "suspended" }).where(eq(users.id, ops[4]!.userId));
    entered.resolve();
    await release.promise;
  });
  await Promise.race([
    entered.promise,
    suspension.then(() => {
      throw Error("Suspension exited before signalling");
    }),
  ]);
  const cancelling = cancelAuditRequest(peers[4]!.db, systemClock, ops[4]!, requestId);
  void cancelling.catch(() => {});
  try {
    await eventually(() => waiting(4), "suspension lock observed");
  } finally {
    release.resolve();
    await Promise.allSettled([suspension, cancelling]);
  }
  await suspension;
  assert.deepEqual(await cancelling, { ok: false, error: "forbidden", message: "操作権限を確認してください" });
  checks.push("suspension committed during preflight prevents cancellation");
  console.log("PASS live permission race");
  const initialCompanies = await Promise.all([seed(admin.db, "PG一括A"), seed(admin.db, "PG一括B")]);
  for (const c of initialCompanies)
    await admin.db.update(companies).set({ pipelineStatus: "collected" }).where(eq(companies.id, c.company.id));
  const preparation = await listAuditPreparation(admin.db, ops[0]!, { query: "PG一括" });
  assert(preparation.ok && preparation.value.total === 2);
  const batch = initialCompanies.map((c) => ({
    companyId: c.company.id,
    websiteId: c.website.id,
    targetUrl: c.website.url,
    requestId: randomUUID(),
  }));
  const batchResults = await Promise.all(
    peers.slice(0, 3).map((p, i) => requestPreparedAudits(p.db, systemClock, ops[i]!, batch)),
  );
  assert(batchResults.every((r) => r.ok && r.value.items.length === 2 && r.value.items.every((item) => item.ok)));
  for (const c of initialCompanies)
    assert.equal(
      (await admin.db.select().from(auditRequests).where(eq(auditRequests.companyId, c.company.id))).length,
      1,
    );
  const preparedAfter = await listAuditPreparation(admin.db, ops[0]!, { query: "PG一括" });
  assert(preparedAfter.ok && preparedAfter.value.total === 0);
  checks.push("3 simultaneous batches over independent PostgreSQL connections create one request per company");
  console.log("PASS concurrent preparation batches");
  // 本番データを使わない。検証専用DBに2,000社×10履歴を構築する。
  await admin.pool.query(`create table qa_bench as select gen_random_uuid() company_id,gen_random_uuid() website_id,n from generate_series(1,2000) n;
 insert into companies(id,name,official_site_status,pipeline_status) select company_id,'架空負荷試験 '||n,'confirmed','failed' from qa_bench;
 insert into websites(id,company_id,url,normalized_url,domain,kind,is_primary) select website_id,company_id,'https://'||company_id||'.example/',company_id||'.example',company_id||'.example','current',true from qa_bench;
 insert into audit_requests(id,company_id,website_id,target_url,status,created_at,finished_at) select gen_random_uuid(),company_id,website_id,'https://'||company_id||'.example/',case when j=10 and n%2=0 then 'completed' else 'failed' end,now()-(11-j)*interval '1 hour',now() from qa_bench cross join generate_series(1,10) j;
 insert into audit_events(actor_kind,action,target_type,target_id,after) select 'system','worker.step_started','worker_step','audit:'||company_id::text||':ops:'||id::text,'{"attempt":1}'::jsonb from audit_requests where company_id in (select company_id from qa_bench);
 analyze audit_requests; analyze audit_events; analyze companies;`);
  async function measure(label: string) {
    const samples = [];
    for (const view of ["open", "attention", "all"] as const) {
      const start = performance.now();
      try {
        const result = await listAuditRequests(admin.db, ops[0]!, { view, query: "架空負荷試験" });
        assert(result.ok);
        assert.equal(result.value.counts.all, 20000);
        assert.equal(result.value.counts.attention, 1000);
        samples.push({ view, ms: Math.round(performance.now() - start), total: result.value.total });
      } catch (error) {
        if ((error as { cause?: { code?: string } }).cause?.code !== "57014") throw error;
        samples.push({
          view,
          ms: Math.round(performance.now() - start),
          error: "query failed or exceeded statement timeout",
        });
      }
      console.log(`${label} ${view}: ${JSON.stringify(samples.at(-1))}`);
    }
    return samples;
  }
  const historyIndex = await admin.pool.query(
    "select indexdef from pg_indexes where schemaname='public' and indexname='audit_requests_company_history'",
  );
  assert.equal(historyIndex.rows.length, 1, "the production migration must provide the company history index");
  // 比較する場合だけ、この一時DB内で索引を外す。通常の回帰検査は適用済み索引で行う。
  if (process.env.SITEOFFER_PG_QA_COMPARE_INDEX === "1") {
    await admin.pool.query("drop index public.audit_requests_company_history");
    try {
      report.baseline = await measure("baseline");
    } finally {
      await admin.pool.query(historyIndex.rows[0].indexdef);
    }
    await admin.pool.query("analyze audit_requests");
  }
  const indexed = await measure("indexed");
  report.indexed = indexed;
  assert(
    indexed.every((sample) => !("error" in sample) && sample.ms < 2000),
    "20k-row list must complete within the 2s regression limit on this isolated fixture",
  );
  // 要確認1,000社のうち500社に保存済み結果を付与。同じ案件を二重に数えない。
  await admin.pool.query(`create table qa_recovery as
    select r.*,gen_random_uuid() audit_id from audit_requests r join qa_bench b on b.company_id=r.company_id
    where b.n%4=1 and r.created_at=(select max(newer.created_at) from audit_requests newer where newer.company_id=r.company_id);
    insert into site_audits(id,company_id,website_id,target_url,status,decision)
      select audit_id,company_id,website_id,target_url,'evaluated','hold' from qa_recovery;
    insert into audit_events(actor_kind,action,target_type,target_id,after)
      select 'system','site_audit.started','site_audit',audit_id::text,
        jsonb_build_object('workerStepKey','audit:'||company_id::text||':ops:'||id::text) from qa_recovery;
    update audit_events e set after=jsonb_build_object('attempt',1,'queue','pipeline.audit','payload',
      jsonb_build_object('companyId',r.company_id::text,'requestKey','ops:'||r.id::text)) from qa_recovery r
      where e.action='worker.step_started' and e.target_id='audit:'||r.company_id::text||':ops:'||r.id::text;
    insert into audit_events(actor_kind,action,target_type,target_id,after)
      select 'system','worker.step_failed','worker_step','audit:'||company_id::text||':ops:'||id::text,
        '{"attempt":1,"final":true}'::jsonb from qa_recovery;
    analyze site_audits; analyze audit_events;`);
  const attentionStart = performance.now();
  const attention = await getAuditAttentionWork(admin.db, ops[0]!);
  const attentionMs = Math.round(performance.now() - attentionStart);
  assert(attention.ok);
  assert.equal(attention.value.total, 1000);
  assert.equal(attention.value.items.length, 20);
  assert(attentionMs < 2000, "mixed diagnostic work must complete within the 2s local regression limit");
  report.attention = { ms: attentionMs, total: attention.value.total, savedResults: 500 };
  console.log(`Mixed diagnostic work: ${JSON.stringify(report.attention)}`);
  const mixed = await measure("mixed");
  report.mixedList = mixed;
  assert(
    mixed.every((sample) => !("error" in sample) && sample.ms < 2000),
    "lists with saved results must complete within the 2s local regression limit",
  );
  const savedCompany = (await admin.pool.query("select company_id from qa_recovery limit 1")).rows[0].company_id;
  const savedList = await listAuditRequests(admin.db, ops[0]!, { companyId: savedCompany, view: "attention" });
  assert(savedList.ok && savedList.value.items[0]?.hasSavedResult);
  checks.push("20k requests and 500 saved results yield 1000 distinct diagnostic followups");
  const plan = await admin.pool.query(
    "explain (analyze,buffers,format json) select count(*) from audit_requests r where r.status in ('failed','blocked') and not exists(select 1 from audit_requests newer where newer.company_id=r.company_id and (newer.created_at,newer.id)>(r.created_at,r.id))",
  );
  report.indexedPlan = plan.rows[0]["QUERY PLAN"];
  report.performanceRows = 20000;
  await mkdir(path.dirname(output), { recursive: true });
  report.status = "passed";
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log("PostgreSQL audit checks passed; report: .data/local-run/postgres-audits-result.json");
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
try {
  await main();
} catch (error) {
  report.status = "failed";
  throw error;
} finally {
  try {
    try {
      await Promise.all(pools.map((p) => p.end()));
    } finally {
      if (container) {
        const owner = await docker(["inspect", "--format", '{{index .Config.Labels "siteoffer.qa.run"}}', container]);
        assert.equal(owner, runId, "only remove this run's container");
        await docker(["rm", "--force", container]);
        report.containerRemoved = true;
        console.log("Removed this run's temporary PostgreSQL container");
      }
    }
  } catch {
    report.status = "failed";
    report.cleanupFailed = true;
    process.exitCode = 1;
    console.error(`Temporary database cleanup failed; inspect container: ${name}`);
  } finally {
    await writeFile(output, JSON.stringify(report, null, 2));
  }
}
