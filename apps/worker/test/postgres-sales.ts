/** Real concurrent backends in an owned, disposable DB; never uses DATABASE_URL. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  claimAssignment,
  confirmContract,
  decideSalesOfferChange,
  fixedClock,
  getSalesOffer,
  proposeSalesOfferChange,
  type Result,
  reassignAssignment,
  recordActivity,
  releaseAssignment,
  reportContract,
  saveDomainPreference,
  suppressCompany,
} from "@siteoffer/core";
import {
  assignments,
  auditEvents,
  companies,
  contracts,
  type Db,
  deliveries,
  productTerms,
  proposalReviewDrafts,
  proposalVersions,
  rewards,
  salesOfferChanges,
} from "@siteoffer/db";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createCompany, createOpsUser, createSalesUser } from "../../../packages/core/src/assignment/test-helpers.ts";
import { reviewProposalVersion } from "../../web/lib/ops/commands.ts";
import { commitReviewDraft, ReviewDraftError, saveReviewDraft } from "../../web/lib/ops/review-drafts.ts";
import { emptyActivity } from "../../web/lib/sales/activity-draft-types.ts";
import {
  ActivityDraftError,
  commitActivityDraft,
  loadActivityDraft,
  saveActivityDraft,
} from "../../web/lib/sales/activity-drafts.ts";

const exec = promisify(execFile),
  repo = fileURLToPath(new URL("../../../", import.meta.url)),
  runId = randomUUID();
const name = `siteoffer-sales-qa-${runId.slice(0, 8)}`,
  password = randomUUID() + randomUUID();
const pools: pg.Pool[] = [],
  checks: string[] = [];
const image = process.env.SITEOFFER_PG_QA_IMAGE ?? "postgres:17.10-alpine";
const report: Record<string, unknown> = { status: "running", image, checks, startedAt: new Date().toISOString() };
const clock = fixedClock("2026-10-17T00:00:00Z");
let container: string | undefined;
async function docker(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return (await exec("docker", args, { env, windowsHide: true, timeout: 30000, maxBuffer: 1048576 })).stdout.trim();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function eventually(fn: () => Promise<boolean>, label: string, timeout = 5000) {
  const until = Date.now() + timeout;
  do {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  } while (Date.now() < until);
  throw Error(`Timed out: ${label}`);
}
function must<T>(r: Result<T, string>): T {
  assert(r.ok, r.ok ? "" : `${r.error}: ${r.message ?? ""}`);
  return r.value;
}
function sqlState(e: unknown) {
  let current = e;
  for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
    if ("code" in current) return String(current.code);
    current = "cause" in current ? current.cause : null;
  }
  return null;
}
/** Pause only after a real statement has acquired its lock, not before SQL is sent. */
async function pauseAfter(pool: pg.Pool, match: (query: string) => boolean) {
  const client = await pool.connect(),
    original = client.query.bind(client),
    ready = deferred(),
    release = deferred();
  let paused = false;
  client.query = ((...args: unknown[]) => {
    const first = args[0],
      q =
        typeof first === "string"
          ? first
          : first && typeof first === "object" && "text" in first
            ? String(first.text)
            : "";
    const result = (original as unknown as (...input: unknown[]) => unknown)(...args);
    if (paused || !match(q)) return result;
    paused = true;
    return (result as Promise<unknown>).then(async (value) => {
      ready.resolve();
      await release.promise;
      return value;
    });
  }) as typeof client.query;
  client.release();
  return {
    ready: ready.promise,
    release: release.resolve,
    restore: () => {
      client.query = original;
    },
  };
}
const assignmentLock = (q: string) =>
  q.startsWith("select ") && q.includes('from "assignments"') && q.includes("for update");
const companyLock = (q: string) =>
  q.startsWith("select ") && q.includes('from "companies"') && q.includes("for update");
const userLock = (q: string) =>
  q.startsWith("select ") && q.includes('from "users"') && q.includes("for no key update");
const proposalLock = (q: string) =>
  q.startsWith("select ") && q.includes('from "proposals"') && q.includes("for update");
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
  assert(/^[a-f0-9]{64}$/.test(container));
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
    "PostgreSQL TCP readiness",
    20000,
  );
  const binding = (await docker(["port", container, "5432/tcp"])).match(/^127\.0\.0\.1:(\d+)$/);
  assert(binding);
  const connectionString = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${binding[1]}/siteoffer_qa`;
  for (let i = 0; i < 7; i++)
    pools.push(
      new pg.Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 5000,
        application_name: `siteoffer-sales-${i}`,
        options: "-c statement_timeout=20000 -c lock_timeout=5000 -c deadlock_timeout=100ms",
      }),
    );
  const admin = pools[0]!,
    peers = pools.slice(1),
    db = drizzle(admin) as unknown as Db,
    dbs = peers.map((p) => drizzle(p) as unknown as Db);
  await migrate(drizzle(admin), { migrationsFolder: path.join(repo, "packages/db/drizzle") });
  const pids = await Promise.all(
    pools.map((p) => p.query("select pg_backend_pid() pid").then((r) => Number(r.rows[0].pid))),
  );
  assert.equal(new Set(pids).size, 7);
  report.independentBackends = pids.length;
  report.serverVersion = (await admin.query("show server_version")).rows[0].server_version;
  const operators = await Promise.all(peers.map(() => createOpsUser(db))),
    ops = operators[0]!.actor;
  async function fixture() {
    const company = await createCompany(db),
      sales = await createSalesUser(db),
      other = await createSalesUser(db),
      a = must(await claimAssignment(db, clock, sales.actor, company.id));
    return { company, sales, other, a };
  }
  async function changeFixture(newProposal = false) {
    const f = await fixture(),
      offer = await getSalesOffer(db, f.company.id, f.a.salesOfferId);
    assert(offer);
    const [terms] = await db
      .insert(productTerms)
      .values({
        version: randomUUID(),
        name: "架空の変更条件",
        scope: {},
        price: 200000,
        rewardRule: { type: "fixed", amount: 12000 },
      })
      .returning();
    const v = newProposal
      ? (
          await db
            .insert(proposalVersions)
            .values({ proposalId: offer.proposal.proposalId, version: 2, status: "approved" })
            .returning()
        )[0]!
      : offer.proposal;
    const input = {
      assignmentId: f.a.id,
      expectedOfferId: offer.offer.id,
      productTermsId: terms!.id,
      proposalVersionId: v.id,
      requestId: randomUUID(),
      reason: "架空の合意済み変更",
    };
    return { ...f, offer, terms: terms!, v, input };
  }
  async function overlap(
    label: string,
    match: (q: string) => boolean,
    first: () => Promise<Result<unknown, string>>,
    second: () => Promise<Result<unknown, string>>,
  ): Promise<[Result<unknown, string>, Result<unknown, string>]> {
    const gate = await pauseAfter(peers[0]!, match);
    const a = first().then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    let b: Promise<{ ok: true; value: Result<unknown, string> } | { ok: false; error: unknown }> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    let observationError: unknown;
    try {
      await Promise.race([
        gate.ready,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(Error(`Missing first lock: ${label}`)), 5000);
        }),
      ]);
      b = second().then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      );
      await eventually(
        async () =>
          Boolean(
            (await admin.query("select $1::int=any(pg_blocking_pids($2::int)) blocked", [pids[1], pids[2]])).rows[0]
              .blocked,
          ),
        `real blocking backend: ${label}`,
      );
    } catch (e) {
      observationError = e;
    } finally {
      if (timer) clearTimeout(timer);
      gate.release();
    }
    try {
      const one = await a,
        two = b ? await b : null;
      if (observationError) throw observationError;
      if (!one.ok) throw one.error;
      assert(two);
      if (!two.ok) throw two.error;
      checks.push(label);
      return [one.value, two.value];
    } finally {
      gate.restore();
    }
  }
  {
    const c = await createCompany(db),
      sales = await Promise.all(peers.map(() => createSalesUser(db)));
    const r = await Promise.all(dbs.map((d, i) => claimAssignment(d, clock, sales[i]!.actor, c.id)));
    assert.equal(r.filter((v) => v.ok).length, 1);
    for (const v of r) if (!v.ok) assert.equal(v.error, "already_assigned");
    assert.equal((await db.select().from(assignments).where(eq(assignments.companyId, c.id))).length, 1);
    checks.push("Six independent simultaneous claims create one active owner");
  }
  {
    const sales = await createSalesUser(db),
      cs = await Promise.all(peers.map(() => createCompany(db)));
    const r = await Promise.all(dbs.map((d, i) => claimAssignment(d, clock, sales.actor, cs[i]!.id)));
    assert.equal(r.filter((v) => v.ok).length, 3);
    for (const v of r) if (!v.ok) assert.equal(v.error, "limit_reached");
    checks.push("Six claims by one salesperson across different companies preserve the limit of three");
  }
  {
    const f = await fixture(),
      reported = await Promise.all(
        dbs.map((d) => reportContract(d, clock, f.sales.actor, { assignmentId: f.a.id, documentRef: "架空.pdf" })),
      );
    assert.equal(reported.filter((v) => v.ok).length, 1);
    for (const v of reported) if (!v.ok) assert.equal(v.error, "already_reported");
    const c = must(reported.find((v) => v.ok)!);
    const completed = await Promise.all(
      dbs.map((d, i) => confirmContract(d, clock, operators[i]!.actor, { contractId: c.id })),
    );
    completed.forEach(must);
    assert.equal(completed.filter((v) => v.ok && !v.value.alreadyCompleted).length, 1);
    assert.equal((await db.select().from(rewards).where(eq(rewards.contractId, c.id))).length, 1);
    assert.equal((await db.select().from(deliveries).where(eq(deliveries.contractId, c.id))).length, 1);
    assert.equal(
      (
        await db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.targetId, c.id), eq(auditEvents.action, "contract.complete")))
      ).length,
      1,
    );
    assert.equal((await db.select().from(rewards).where(eq(rewards.contractId, c.id)))[0]!.amount, 10000);
    checks.push("Six reports and six confirmations create one pinned contract, reward, delivery and completion audit");
  }
  {
    const f = await fixture(),
      c = must(await reportContract(db, clock, f.sales.actor, { assignmentId: f.a.id, documentRef: "架空.pdf" }));
    await admin.query(
      "create function fail_handoff() returns trigger language plpgsql as $$ begin if new.action='delivery.create' then raise exception 'fixture rollback'; end if; return new; end $$; create trigger fail_handoff before insert on audit_events for each row execute function fail_handoff()",
    );
    try {
      await assert.rejects(confirmContract(dbs[0]!, clock, ops, { contractId: c.id }));
    } finally {
      await admin.query("drop trigger fail_handoff on audit_events; drop function fail_handoff()");
    }
    assert.equal((await db.select().from(contracts).where(eq(contracts.id, c.id)))[0]!.status, "reported");
    assert.equal(
      (await db.select().from(assignments).where(eq(assignments.id, f.a.id)))[0]!.status,
      "contract_pending",
    );
    assert.equal((await db.select().from(rewards).where(eq(rewards.contractId, c.id))).length, 0);
    assert.equal((await db.select().from(deliveries).where(eq(deliveries.contractId, c.id))).length, 0);
    must(await confirmContract(dbs[1]!, clock, ops, { contractId: c.id }));
    checks.push("A failing handoff audit rolls back contract, owner, reward and delivery; retry succeeds once");
  }
  for (const mode of ["reassign", "report", "activity", "domain", "draft"] as const)
    for (const firstStop of [false, true]) {
      const f = await fixture(),
        values = emptyActivity(clock.now());
      values.note = "途中でも保持する架空の活動";
      const copy = mode === "draft" ? await saveActivityDraft(db, clock, f.sales.actor, f.a.id, 0, values) : null;
      const work = (d: Db) => {
        if (mode === "reassign")
          return reassignAssignment(d, clock, ops, {
            assignmentId: f.a.id,
            toUserId: f.other.user.id,
            reason: "架空の担当変更",
          });
        if (mode === "report")
          return reportContract(d, clock, f.sales.actor, { assignmentId: f.a.id, documentRef: "架空.pdf" });
        if (mode === "activity")
          return recordActivity(d, clock, f.sales.actor, {
            assignmentId: f.a.id,
            kind: "no_answer",
            note: "架空の活動",
          });
        if (mode === "domain")
          return saveDomainPreference(d, clock, f.sales.actor, {
            companyId: f.company.id,
            assignmentId: f.a.id,
            intent: "keep",
          });
        return commitActivityDraft(d, clock, f.sales.actor, f.a.id, {
          revision: copy!.revision,
          values,
          requestKey: randomUUID(),
          confirmEnd: false,
        }).then(
          (value) => ({ ok: true as const, value }),
          (e) => {
            if (e instanceof ActivityDraftError) return { ok: false as const, error: "assignment_ended" };
            throw e;
          },
        );
      };
      const stop = (d: Db) =>
        suppressCompany(d, clock, ops, { companyId: f.company.id, kind: "do_not_contact", reason: "架空の営業拒否" });
      const [a, b] = await overlap(
        `${mode} / suppression: ${firstStop ? "suppression" : "operation"} first`,
        firstStop ? companyLock : assignmentLock,
        () => (firstStop ? stop(dbs[0]!) : work(dbs[0]!)),
        () => (firstStop ? work(dbs[1]!) : stop(dbs[1]!)),
      );
      const stopped = firstStop ? a : b,
        worked = firstStop ? b : a;
      must(stopped);
      if (firstStop) {
        assert.equal(worked.ok, false);
        if (mode === "draft") assert.deepEqual((await loadActivityDraft(db, f.sales.actor, f.a.id)).values, values);
      } else must(worked);
      assert.equal(
        (await db.select().from(companies).where(eq(companies.id, f.company.id)))[0]!.suppression,
        "do_not_contact",
      );
      assert.equal(
        (
          await db
            .select()
            .from(assignments)
            .where(
              and(
                eq(assignments.companyId, f.company.id),
                inArray(assignments.status, ["claimed", "working", "negotiating", "awaiting_ops", "contract_pending"]),
              ),
            )
        ).length,
        0,
      );
    }
  for (const mode of ["propose", "decide"] as const)
    for (const firstStop of [false, true]) {
      const f = await changeFixture(),
        change = mode === "decide" ? must(await proposeSalesOfferChange(db, clock, ops, f.input)) : null;
      const work = (d: Db) =>
        mode === "propose"
          ? proposeSalesOfferChange(d, clock, ops, f.input)
          : decideSalesOfferChange(d, clock, f.sales.actor, {
              changeId: change!.id,
              decision: "accept",
              confirmed: true,
            });
      const stop = (d: Db) =>
        suppressCompany(d, clock, ops, { companyId: f.company.id, kind: "do_not_contact", reason: "架空の停止" });
      const [a, b] = await overlap(
        `offer ${mode} / suppression: ${firstStop ? "suppression" : "operation"} first`,
        firstStop ? companyLock : assignmentLock,
        () => (firstStop ? stop(dbs[0]!) : work(dbs[0]!)),
        () => (firstStop ? work(dbs[1]!) : stop(dbs[1]!)),
      );
      must(firstStop ? a : b);
      assert.equal((firstStop ? b : a).ok, !firstStop);
      const rows = await db.select().from(salesOfferChanges).where(eq(salesOfferChanges.assignmentId, f.a.id));
      assert(rows.every((r) => r.status !== "pending"));
    }
  for (const firstClaim of [false, true]) {
    const f = await fixture(),
      move = (d: Db) =>
        reassignAssignment(d, clock, ops, {
          assignmentId: f.a.id,
          toUserId: f.other.user.id,
          reason: "架空の引き継ぎ",
        }),
      claim = (d: Db) => claimAssignment(d, clock, f.other.actor, f.company.id);
    const [a, b] = await overlap(
      `claim / reassignment: ${firstClaim ? "claim" : "reassignment"} first`,
      firstClaim ? userLock : assignmentLock,
      () => (firstClaim ? claim(dbs[0]!) : move(dbs[0]!)),
      () => (firstClaim ? move(dbs[1]!) : claim(dbs[1]!)),
    );
    must(firstClaim ? b : a);
    assert.equal((firstClaim ? a : b).ok, false);
  }
  {
    const f = await fixture();
    const [a, b] = await overlap(
      "Activity FK writes do not deadlock behind a claimant's user lock",
      assignmentLock,
      () => recordActivity(dbs[0]!, clock, f.sales.actor, { assignmentId: f.a.id, kind: "no_answer" }),
      () => claimAssignment(dbs[1]!, clock, f.sales.actor, f.company.id),
    );
    must(a);
    assert.equal(b.ok, false);
  }
  {
    const f = await changeFixture(),
      change = must(await proposeSalesOfferChange(db, clock, ops, f.input));
    const [a, b] = await overlap(
      "A condition decision waits for claimant user before locking its company",
      userLock,
      () => claimAssignment(dbs[0]!, clock, f.sales.actor, f.company.id),
      () =>
        decideSalesOfferChange(dbs[1]!, clock, f.sales.actor, {
          changeId: change.id,
          decision: "accept",
          confirmed: true,
        }),
    );
    assert.equal(a.ok, false);
    must(b);
  }
  for (const firstReview of [false, true]) {
    const f = await changeFixture(true),
      change = must(await proposeSalesOfferChange(db, clock, ops, f.input));
    const decide = (d: Db) =>
      decideSalesOfferChange(d, clock, f.sales.actor, { changeId: change.id, decision: "accept", confirmed: true });
    const review = (d: Db) =>
      reviewProposalVersion({ db: d, clock }, ops, {
        proposalVersionId: f.v.id,
        decision: "rejected",
        note: "架空の古いレビュー操作",
      });
    const [a, b] = await overlap(
      `review / offer decision: ${firstReview ? "review" : "decision"} first`,
      firstReview ? proposalLock : assignmentLock,
      () => (firstReview ? review(dbs[0]!) : decide(dbs[0]!)),
      () => (firstReview ? decide(dbs[1]!) : review(dbs[1]!)),
    );
    must(firstReview ? b : a);
    const rejected = firstReview ? a : b;
    assert.equal(rejected.ok, false);
  }
  for (const firstRelease of [false, true]) {
    const f = await fixture(),
      release = (d: Db) => releaseAssignment(d, clock, f.sales.actor, { assignmentId: f.a.id, reason: "架空の解除" }),
      makeReport = (d: Db) =>
        reportContract(d, clock, f.sales.actor, { assignmentId: f.a.id, documentRef: "架空.pdf" });
    const [a, b] = await overlap(
      `release / report: ${firstRelease ? "release" : "report"} first`,
      assignmentLock,
      () => (firstRelease ? release(dbs[0]!) : makeReport(dbs[0]!)),
      () => (firstRelease ? makeReport(dbs[1]!) : release(dbs[1]!)),
    );
    must(a);
    assert.equal(b.ok, false);
  }
  // Every paused test has observed an actual backend lock wait and completed its transactions.
  for (const mode of ["save", "commit"] as const) {
    const f = await changeFixture(true),
      change = must(await proposeSalesOfferChange(db, clock, ops, f.input));
    const values = {
      note: "別画面の承認前に保存した確認メモ",
      company: false,
      rights: false,
      devices: false,
      links: false,
      continuity: false,
    };
    assert(ops.kind === "ops");
    await db
      .insert(proposalReviewDrafts)
      .values({ userId: ops.userId, proposalVersionId: f.v.id, revision: 1, values, updatedAt: clock.now() });
    const [decision, stale] = await overlap(
      `stale review ${mode} / condition decision`,
      assignmentLock,
      () =>
        decideSalesOfferChange(dbs[0]!, clock, f.sales.actor, {
          changeId: change.id,
          decision: "accept",
          confirmed: true,
        }),
      () =>
        (mode === "save"
          ? saveReviewDraft(dbs[1]!, clock, ops, f.v.id, 1, values)
          : commitReviewDraft(dbs[1]!, clock, ops, f.v.id, {
              revision: 1,
              decision: "rejected",
              requestKey: randomUUID(),
            })
        ).then(
          (value) => ({ ok: true as const, value }),
          (e) => {
            if (e instanceof ReviewDraftError) return { ok: false as const, error: "stale_review" };
            throw e;
          },
        ),
    );
    must(decision);
    assert.equal(stale.ok, false);
    const [copy] = await db
      .select()
      .from(proposalReviewDrafts)
      .where(eq(proposalReviewDrafts.proposalVersionId, f.v.id));
    assert.deepEqual(copy?.values, values);
  }

  report.status = "passed";
}
try {
  await main();
} catch (e) {
  report.status = "failed";
  report.errorCode = sqlState(e);
  report.error = e instanceof Error ? e.message : "Unknown failure";
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await Promise.allSettled(pools.map((p) => p.end()));
  if (container) {
    try {
      assert.equal(
        await docker(["inspect", "--format", '{{ index .Config.Labels "siteoffer.qa.run" }}', container]),
        runId,
      );
      await docker(["rm", "--force", container]);
      report.containerRemoved = true;
    } catch {
      report.cleanupFailed = true;
      report.status = "failed";
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(path.join(repo, ".data/local-run"), { recursive: true });
  await writeFile(path.join(repo, ".data/local-run/postgres-sales-result.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      status: report.status,
      serverVersion: report.serverVersion,
      independentBackends: report.independentBackends,
      checks: checks.length,
      containerRemoved: report.containerRemoved,
    }),
  );
}
