/** Concurrent content operations in an owned disposable PostgreSQL. Never uses DATABASE_URL. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ArticleWorkspaceConflict,
  attachImageAssetFile,
  ContentError,
  createDeliveryForContract,
  findPublishedArticle,
  fixedClock,
  getPublishedArticleImage,
  hasPublishedSite,
  loadArticleWorkspace,
  publishArticle,
  revokeContentEditor,
  saveArticle,
  saveArticleWorkingCopy,
  submitArticleOperation,
} from "@siteoffer/core";
import {
  contentAccess,
  contentEntries,
  contentOperations,
  contentRevisions,
  contentWorkingCopies,
  type Db,
  deliveries,
  imageAssets,
  users,
} from "@siteoffer/db";
import { normalizeAssetImage } from "@siteoffer/generation/images";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import sharp from "sharp";
import { seedDeliveryBase } from "../../../packages/core/src/delivery/test-helpers.ts";
import { updateImageAssetPolicy } from "../../web/lib/ops/commands.ts";

const exec = promisify(execFile),
  repo = fileURLToPath(new URL("../../../", import.meta.url)),
  runId = randomUUID();
const name = `siteoffer-content-qa-${runId.slice(0, 8)}`,
  image = "postgres:17.10-alpine";
const password = randomUUID() + randomUUID(),
  pools: pg.Pool[] = [],
  checks: string[] = [];
const observations: { label: string; backend: number; blockers: number[] }[] = [];
const evidence = path.join(repo, ".data/local-run/postgres-content", runId);
const report: Record<string, unknown> = {
  status: "running",
  runId,
  image,
  checks,
  observations,
  startedAt: new Date().toISOString(),
  modelCalls: 0,
  normalDatabaseUsed: false,
  webServerStarted: false,
};
const clock = fixedClock("2026-10-19T00:00:00Z");
let container: string | undefined;
async function docker(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return (await exec("docker", args, { env, windowsHide: true, timeout: 30000, maxBuffer: 1048576 })).stdout.trim();
}
async function eventually(test: () => Promise<boolean>, label: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  do {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw Error(`Timed out: ${label}`);
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
type Outcome<T> = Awaited<ReturnType<typeof outcome<T>>>;
function succeeded<T>(result: Outcome<T>) {
  if (!result.ok) throw result.error;
  return result.value;
}
function contentFailure<T>(result: Outcome<T>) {
  assert(!result.ok);
  assert(result.error instanceof ContentError || result.error instanceof ArticleWorkspaceConflict);
  return result.error;
}
async function main() {
  const endpoint =
    process.env.DOCKER_HOST?.trim() || (await docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]));
  const local =
    endpoint.startsWith("npipe://") ||
    endpoint.startsWith("unix://") ||
    /^tcp:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/.test(endpoint);
  assert(local, "Use a local Docker endpoint for this disposable test");
  await docker(["image", "inspect", "--format", "{{.Id}}", image]);
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
    "PostgreSQL readiness",
    20000,
  );
  const binding = (await docker(["port", container, "5432/tcp"])).match(/^127\.0\.0\.1:(\d+)$/);
  assert(binding);
  const connectionString = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${binding[1]}/siteoffer_qa`;
  for (let i = 0; i < 4; i++)
    pools.push(
      new pg.Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 5000,
        application_name: `siteoffer-content-${i}`,
        options: "-c statement_timeout=30000 -c lock_timeout=15000 -c deadlock_timeout=100ms",
      }),
    );
  const [admin, holder, peerA, peerB] = pools as [pg.Pool, pg.Pool, pg.Pool, pg.Pool];
  const db = drizzle(admin) as unknown as Db,
    a = drizzle(peerA) as unknown as Db,
    b = drizzle(peerB) as unknown as Db;
  assert.equal((await admin.query("select current_database() name")).rows[0].name, "siteoffer_qa");
  await migrate(drizzle(admin), { migrationsFolder: path.join(repo, "packages/db/drizzle") });
  const pids = await Promise.all(
    pools.map((pool) => pool.query("select pg_backend_pid() pid").then((r) => Number(r.rows[0].pid))),
  );
  assert.equal(new Set(pids).size, 4);
  report.independentBackends = pids.length;
  report.serverVersion = (await admin.query("show server_version")).rows[0].server_version;
  async function blocked(index: number, label: string, blocker?: number) {
    await eventually(async () => {
      const r = await admin.query(
        "select wait_event_type,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1",
        [pids[index]],
      );
      const row = r.rows[0];
      if (
        row?.wait_event_type !== "Lock" ||
        !row.blockers.length ||
        (blocker !== undefined && !row.blockers.includes(blocker))
      )
        return false;
      observations.push({ label, backend: pids[index]!, blockers: row.blockers });
      return true;
    }, label);
  }
  async function together<T, U>(companyId: string, label: string, first: () => Promise<T>, second: () => Promise<U>) {
    await holder.query("begin");
    await holder.query("select id from companies where id=$1 for update", [companyId]);
    const left = outcome(first()),
      right = outcome(second());
    let observationError: unknown;
    try {
      await blocked(2, `${label}: first`);
      await blocked(3, `${label}: second`);
    } catch (error) {
      observationError = error;
    } finally {
      await holder.query("rollback");
    }
    const result = await Promise.all([left, right]);
    if (observationError) throw observationError;
    return result;
  }
  async function ordered<T, U>(key: number, label: string, first: () => Promise<T>, second: () => Promise<U>) {
    await holder.query("select pg_advisory_lock($1)", [key]);
    const left = outcome(first());
    let right: Promise<Outcome<U>> | undefined, observationError: unknown;
    try {
      await blocked(2, `${label}: change paused`, pids[1]);
      right = outcome(second());
      await blocked(3, `${label}: writer blocked`, pids[2]);
    } catch (error) {
      observationError = error;
    } finally {
      await holder.query("select pg_advisory_unlock($1)", [key]);
    }
    const result = [await left, right ? await right : undefined] as const;
    if (observationError) throw observationError;
    assert(result[1]);
    return [result[0], result[1]] as const;
  }
  async function fixture() {
    const base = await seedDeliveryBase(db);
    const [user] = await db
      .insert(users)
      .values({
        email: `${randomUUID()}@example.test`,
        role: "customer",
        displayName: "架空の記事担当",
        passwordHash: "test-only-not-a-login",
      })
      .returning();
    const [access] = await db
      .insert(contentAccess)
      .values({
        companyId: base.company.id,
        contractId: base.contract.id,
        email: user!.email,
        userId: user!.id,
        status: "active",
        tokenHash: randomUUID(),
        expiresAt: clock.now(),
        requestId: randomUUID(),
        createdBy: base.ops.userId,
        acceptedAt: clock.now(),
        updatedAt: clock.now(),
      })
      .returning();
    const delivery = await createDeliveryForContract(db, clock, base.ops, base.contract.id);
    assert(delivery.ok);
    await db.update(deliveries).set({ status: "published" }).where(eq(deliveries.id, delivery.value.delivery.id));
    assert(await hasPublishedSite(db, base.company.id));
    return {
      ...base,
      access: access!,
      customer: { kind: "customer_user", userId: user!.id } as const,
      scope: { companyId: base.company.id, entryId: null as string | null },
    };
  }
  const values = { slug: "first-news", title: "最初の記事", body: "掲載前の本文", category: "news", baseRevision: "0" };
  // A lost response and concurrent double-clicks must not create a second article or consume a later copy.
  {
    const f = await fixture(),
      request = { kind: "save", requestId: randomUUID(), copyRevision: 1 } as const;
    await saveArticleWorkingCopy(db, clock, f.customer, f.scope, 0, values);
    const pair = await together(
      f.company.id,
      "same article request",
      () => submitArticleOperation(a, clock, f.customer, f.scope, request),
      () => submitArticleOperation(b, clock, f.customer, f.scope, request),
    );
    const result = pair.map(succeeded);
    assert.deepEqual(result.map((r) => r.replayed).sort(), [false, true]);
    assert.equal(result[0]!.workspace.scope.entryId, result[1]!.workspace.scope.entryId);
    const next = { ...values, slug: "next-news", body: "次の記事の入力を保持する" };
    await saveArticleWorkingCopy(db, clock, f.customer, f.scope, 2, next);
    assert((await submitArticleOperation(a, clock, f.customer, f.scope, request)).replayed);
    assert.deepEqual((await loadArticleWorkspace(db, f.customer, f.scope)).copy.values, next);
    assert.equal((await db.select().from(contentEntries).where(eq(contentEntries.companyId, f.company.id))).length, 1);
    assert.equal(
      (await db.select().from(contentOperations).where(eq(contentOperations.companyId, f.company.id))).length,
      1,
    );
    await revokeContentEditor(db, clock, f.ops, { companyId: f.company.id, accessId: f.access.id, revision: 1 });
    await assert.rejects(submitArticleOperation(a, clock, f.customer, f.scope, request), ContentError);
    checks.push("same request creates one article; replay preserves later input and rechecks revoked access");
  }
  // Two editors start from the same article. The losing editor's private input must remain intact.
  {
    const f = await fixture();
    const entry = await saveArticle(db, clock, f.customer, { ...values, companyId: f.company.id });
    const scope = { ...f.scope, entryId: entry.id };
    await publishArticle(db, clock, f.customer, {
      companyId: f.company.id,
      entryId: entry.id,
      revision: 1,
      expectedRevision: 1,
      expectedPublicationRevision: 0,
    });
    const actors = [f.customer, f.ops],
      edits = ["顧客が編集中の本文", "運営が編集中の本文"].map((body) => ({ ...values, body, baseRevision: "1" }));
    for (let i = 0; i < 2; i++) await saveArticleWorkingCopy(db, clock, actors[i]!, scope, 0, edits[i]!);
    const pair = await together(
      f.company.id,
      "different editors",
      () =>
        submitArticleOperation(a, clock, actors[0]!, scope, { kind: "save", requestId: randomUUID(), copyRevision: 1 }),
      () =>
        submitArticleOperation(b, clock, actors[1]!, scope, { kind: "save", requestId: randomUUID(), copyRevision: 1 }),
    );
    assert.equal(pair.filter((r) => r.ok).length, 1);
    const loser = pair.findIndex((r) => !r.ok);
    contentFailure(pair[loser]!);
    assert.deepEqual((await loadArticleWorkspace(db, actors[loser]!, scope)).copy.values, edits[loser]);
    assert.equal((await db.select().from(contentRevisions).where(eq(contentRevisions.entryId, entry.id))).length, 2);
    assert.equal((await findPublishedArticle(db, f.company.id, entry.slug))?.body, values.body);
    checks.push("concurrent editors create one revision; losing input remains private and published text is unchanged");
  }
  {
    const f = await fixture(),
      entry = await saveArticle(db, clock, f.customer, { ...values, companyId: f.company.id });
    await saveArticle(db, clock, f.ops, {
      ...values,
      companyId: f.company.id,
      entryId: entry.id,
      expectedRevision: 1,
      body: "第2版の本文",
    });
    await publishArticle(db, clock, f.customer, {
      companyId: f.company.id,
      entryId: entry.id,
      revision: 1,
      expectedRevision: 2,
      expectedPublicationRevision: 0,
    });
    const scope = { ...f.scope, entryId: entry.id },
      left = {
        kind: "publish",
        requestId: randomUUID(),
        expectedRevision: 2,
        expectedPublicationRevision: 1,
        revision: 2,
        confirmed: true,
      } as const,
      right = { ...left, requestId: randomUUID(), revision: null };
    const pair = await together(
      f.company.id,
      "publish and unpublish",
      () => submitArticleOperation(a, clock, f.customer, scope, left),
      () => submitArticleOperation(b, clock, f.ops, scope, right),
    );
    assert.equal(pair.filter((r) => r.ok).length, 1);
    contentFailure(pair.find((r) => !r.ok)!);
    const [saved] = await db.select().from(contentEntries).where(eq(contentEntries.id, entry.id));
    assert.equal(saved!.publicationRevision, 2);
    assert.equal(saved!.publishedRevision, pair[0].ok ? 2 : null);
    assert.equal(
      (await findPublishedArticle(db, f.company.id, entry.slug))?.body ?? null,
      pair[0].ok ? "第2版の本文" : null,
    );
    const request = pair[0].ok ? left : right,
      who = pair[0].ok ? f.customer : f.ops;
    assert((await submitArticleOperation(a, clock, who, scope, request)).replayed);
    assert.equal(
      (await db.select().from(contentEntries).where(eq(contentEntries.id, entry.id)))[0]!.publicationRevision,
      2,
    );
    checks.push("concurrent publish and unpublish apply one decision; response replay does not publish again");
  }
  await admin.query(
    "create function qa_pause_access_revoke() returns trigger language plpgsql as $$ begin if new.status='revoked' then perform pg_advisory_xact_lock(88001); end if; return new; end $$",
  );
  await admin.query(
    "create trigger qa_access_revoke before update on content_access for each row execute function qa_pause_access_revoke()",
  );
  {
    const f = await fixture();
    await saveArticleWorkingCopy(db, clock, f.customer, f.scope, 0, values);
    const pair = await ordered(
      88001,
      "access revoke before save",
      () => revokeContentEditor(a, clock, f.ops, { companyId: f.company.id, accessId: f.access.id, revision: 1 }),
      () =>
        submitArticleOperation(b, clock, f.customer, f.scope, {
          kind: "save",
          requestId: randomUUID(),
          copyRevision: 1,
        }),
    );
    succeeded(pair[0]);
    contentFailure(pair[1]);
    const [copy] = await db
      .select()
      .from(contentWorkingCopies)
      .where(and(eq(contentWorkingCopies.companyId, f.company.id), eq(contentWorkingCopies.userId, f.customer.userId)));
    assert.deepEqual(copy!.values, values);
    assert.equal((await db.select().from(contentEntries).where(eq(contentEntries.companyId, f.company.id))).length, 0);
    assert.equal(
      (await db.select().from(contentOperations).where(eq(contentOperations.companyId, f.company.id))).length,
      0,
    );
    checks.push("revocation holds the company lock; a waiting customer cannot save and their input is retained");
  }
  await admin.query(
    "create function qa_pause_image_revoke() returns trigger language plpgsql as $$ begin if old.allow_production and not new.allow_production then perform pg_advisory_xact_lock(88002); end if; return new; end $$",
  );
  await admin.query(
    "create trigger qa_image_revoke before update on image_assets for each row execute function qa_pause_image_revoke()",
  );
  {
    const f = await fixture();
    const [asset] = await db
      .insert(imageAssets)
      .values({ companyId: f.company.id, label: "検証用の1px画像", sourceType: "generated" })
      .returning();
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#28734c" } })
      .png()
      .toBuffer();
    await attachImageAssetFile(db, clock, f.ops, {
      companyId: f.company.id,
      assetId: asset!.id,
      ...(await normalizeAssetImage(png)),
    });
    const policy = {
      companyId: f.company.id,
      imageAssetId: asset!.id,
      rightsStatus: "use_approved",
      allowSalesDemo: false,
      allowProduction: true,
      placement: "reference",
      expectedRevision: 1,
      note: "独立した架空データの試験",
    } as const;
    const approved = await updateImageAssetPolicy({ db, clock }, f.ops, policy);
    assert(approved.ok);
    const entry = await saveArticle(db, clock, f.customer, {
      ...values,
      companyId: f.company.id,
      images: [{ assetId: asset!.id, alt: "検証用画像", caption: "" }],
    });
    await publishArticle(db, clock, f.customer, {
      companyId: f.company.id,
      entryId: entry.id,
      revision: 1,
      expectedRevision: 1,
      expectedPublicationRevision: 0,
    });
    assert(await getPublishedArticleImage(db, f.company.id, entry.id, asset!.id));
    await saveArticle(db, clock, f.customer, {
      ...values,
      companyId: f.company.id,
      entryId: entry.id,
      expectedRevision: 1,
      body: "写真を残した第2版",
      images: [{ assetId: asset!.id, alt: "検証用画像", caption: "" }],
    });
    const scope = { ...f.scope, entryId: entry.id };
    const pair = await ordered(
      88002,
      "image withdrawal before publish",
      () =>
        updateImageAssetPolicy({ db: a, clock }, f.ops, {
          ...policy,
          allowProduction: false,
          expectedRevision: approved.value.policyRevision,
        }),
      () =>
        submitArticleOperation(b, clock, f.customer, scope, {
          kind: "publish",
          requestId: randomUUID(),
          expectedRevision: 2,
          expectedPublicationRevision: 1,
          revision: 2,
          confirmed: true,
        }),
    );
    assert(succeeded(pair[0]).ok);
    contentFailure(pair[1]);
    const article = await findPublishedArticle(db, f.company.id, entry.slug);
    assert.equal(article?.revision, 1);
    assert.deepEqual(article?.images, []);
    assert.equal(await getPublishedArticleImage(db, f.company.id, entry.id, asset!.id), null);
    assert.equal(
      (await db.select().from(contentEntries).where(eq(contentEntries.id, entry.id)))[0]!.publicationRevision,
      1,
    );
    checks.push("withdrawn photos block waiting publication and disappear from fresh public text/image requests");
  }
  {
    const first = await fixture(),
      other = await fixture();
    await holder.query("begin");
    await holder.query("select id from companies where id=$1 for update", [first.company.id]);
    const waiting = outcome(saveArticle(a, clock, first.customer, { ...values, companyId: first.company.id }));
    try {
      await blocked(2, "unrelated company stays available");
      const entry = await saveArticle(b, clock, other.customer, { ...values, companyId: other.company.id });
      assert.equal(entry.currentRevision, 1);
    } finally {
      await holder.query("rollback");
    }
    succeeded(await waiting);
    checks.push("a blocked company does not block another company's editor");
  }
  report.status = "passed";
}
try {
  await main();
} catch (error) {
  report.status = "failed";
  report.error =
    error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g, "[connection]") : "Unknown test failure";
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await Promise.allSettled(pools.map((pool) => pool.end()));
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
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, "result.json"), JSON.stringify(report, null, 2));
  await writeFile(
    path.join(repo, ".data/local-run/postgres-content-latest.json"),
    JSON.stringify({ runId, evidence, status: report.status }, null, 2),
  );
  console.log(
    JSON.stringify({
      status: report.status,
      serverVersion: report.serverVersion,
      independentBackends: report.independentBackends,
      checks: checks.length,
      observedLockWaits: observations.length,
      containerRemoved: report.containerRemoved,
    }),
  );
}
