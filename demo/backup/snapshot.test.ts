import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedCandidate } from "../../apps/web/lib/ops/test-seed.ts";
import { seedDeliveryBase } from "../../packages/core/src/delivery/test-helpers.ts";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import type { Db } from "../../packages/db/src/db.ts";
import {
  contentEntries,
  contentRevisions,
  deliveries,
  deliveryBuilds,
  deliveryVersions,
  imageAssetFiles,
  imageAssets,
  proposalVersions,
  siteAudits,
} from "../../packages/db/src/index.ts";
import { type PGliteServer, startPGliteServer } from "../../packages/db/src/pglite-server.ts";
import * as bundle from "./bundle.ts";
import { BackupError, ensurePlainDirectory, removeOwnedDirectory } from "./bundle.ts";
import { startBackupControl } from "./control.ts";
import { requestControl } from "./control-client.ts";
import { acquireOwner } from "./owner.ts";
import { pgliteRuntime } from "./runtime.ts";
import { captureDatabase, createSnapshot, restoreSnapshot, type SnapshotDb, saveSnapshot } from "./snapshot.ts";
import { latestVerification, verifySnapshot } from "./verify.ts";

const parent = path.resolve(".data/local-run/backup-integration");
let home: string,
  raw: SnapshotDb | undefined,
  server: PGliteServer | undefined,
  control: Awaited<ReturnType<typeof startBackupControl>> | undefined,
  lease: Awaited<ReturnType<typeof acquireOwner>> | undefined;
const recoveryKey = Buffer.alloc(32, 1).toString("base64url");
const password = "架空の保存用パスフレーズ2026",
  runtime = pgliteRuntime();
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function host(
  f: Awaited<ReturnType<typeof fixture>>,
  verify?: Parameters<typeof startBackupControl>[0]["verify"],
) {
  server ??= await startPGliteServer(raw as Awaited<ReturnType<typeof runtime.PGlite.create>>, {
    host: "127.0.0.1",
    port: 0,
  });
  control = await startBackupControl({
    db: raw!,
    server,
    dataRoot: f.dataRoot,
    backupRoot: f.backupRoot,
    artifactRoots: [f.artifacts],
    engineVersion: runtime.version,
    ownerNonce: lease!.owner.nonce,
    stop: () => {},
    verify:
      verify ??
      ((file, password, signal) =>
        verifySnapshot({
          file,
          password,
          signal,
          restoreRoot: f.restoreRoot,
          engineVersion: runtime.version,
          create: (dataDir, loadDataDir) => runtime.PGlite.create({ dataDir, loadDataDir }),
        })),
  });
}
beforeEach(async () => {
  await ensurePlainDirectory(parent);
  home = path.join(parent, `backup-${randomUUID()}`);
  await mkdir(home);
});
afterEach(async () => {
  await control?.stop();
  await server?.stop();
  await raw?.close();
  await lease?.release();
  control = undefined;
  server = undefined;
  raw = undefined;
  lease = undefined;
  await removeOwnedDirectory(home, parent);
  vi.restoreAllMocks();
});
async function fixture() {
  const dataRoot = await ensurePlainDirectory(path.join(home, "data")),
    backupRoot = await ensurePlainDirectory(path.join(home, "backups")),
    restoreRoot = await ensurePlainDirectory(path.join(home, "restores")),
    artifacts = await ensurePlainDirectory(path.join(dataRoot, "artifacts"));
  lease = await acquireOwner(dataRoot);
  raw = await runtime.PGlite.create(path.join(dataRoot, "pglite"));
  const fromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url)),
    { drizzle } = fromDb("drizzle-orm/pglite") as { drizzle: (p: unknown) => Db },
    { migrate } = fromDb("drizzle-orm/pglite/migrator") as {
      migrate: (d: unknown, o: { migrationsFolder: string }) => Promise<void>;
    };
  const db = drizzle(raw);
  await migrate(db, { migrationsFolder: path.resolve("packages/db/drizzle") });
  const candidate = await seedCandidate(db),
    delivery = await seedDeliveryBase(db);
  const [d] = await db.insert(deliveries).values({ contractId: delivery.contract.id, status: "delivered" }).returning(),
    [build] = await db
      .insert(deliveryBuilds)
      .values({ deliveryId: d!.id, status: "succeeded", imageAssetSnapshot: [] })
      .returning();
  const dirs = [] as string[];
  for (const name of ["demo", "delivery", "audit"]) {
    const dir = await ensurePlainDirectory(path.join(artifacts, name));
    dirs.push(dir);
    await writeFile(
      path.join(dir, "index.html"),
      `<!doctype html><html lang="ja"><title>架空・${name}</title><h1>復元したサイト</h1></html>`,
    );
    await writeFile(path.join(dir, "店舗写真.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]));
  }
  await db
    .update(proposalVersions)
    .set({ demoArtifactDir: dirs[0] })
    .where(eq(proposalVersions.id, candidate.version!.id));
  await db.update(siteAudits).set({ artifactDir: dirs[2] }).where(eq(siteAudits.id, candidate.audit.id));
  await db.insert(deliveryVersions).values({ deliveryId: d!.id, buildId: build!.id, version: 1, artifactDir: dirs[1] });
  const bytes = Buffer.from("fixture-image-bytes"),
    [asset] = await db
      .insert(imageAssets)
      .values({ companyId: delivery.company.id, label: "架空の写真", sourceType: "customer_upload" })
      .returning();
  await db.insert(imageAssetFiles).values({
    assetId: asset!.id,
    pngBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: 1,
    height: 1,
    byteSize: bytes.length,
    uploadedBy: delivery.ops.userId,
  });
  const [entry] = await db
    .insert(contentEntries)
    .values({
      companyId: delivery.company.id,
      slug: "backup-article",
      currentRevision: 1,
      publishedRevision: 1,
      publicationRevision: 1,
      updatedAt: new Date(),
    })
    .returning();
  await db.insert(contentRevisions).values({
    entryId: entry!.id,
    revision: 1,
    title: "復元する日本語の記事",
    body: "写真と本文を失わずに戻す",
    category: "news",
    createdBy: delivery.ops.userId,
    images: [{ assetId: asset!.id, alt: "内装", caption: "架空の店舗" }],
  });
  await writeFile(path.join(dataRoot, "share-token-key"), recoveryKey);
  await writeFile(
    path.join(dataRoot, "users.json"),
    '[{"email":"fixture@example.test","password":"fixture-password"}]',
  );
  return { dataRoot, backupRoot, restoreRoot, artifacts, dirs };
}
async function digest(db: SnapshotDb) {
  const tables = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name",
  );
  const hashes: Record<string, string> = {};
  for (const { table_name: name } of tables.rows) {
    const exclude =
      name === "proposal_versions"
        ? " - 'demo_artifact_dir'"
        : name === "delivery_versions" || name === "site_audits"
          ? " - 'artifact_dir'"
          : "";
    const result = await db.query<{ value: unknown }>(
      `select to_jsonb(t)${exclude} as value from "${name.replaceAll('"', '""')}" t`,
    );
    hashes[name] = createHash("sha256")
      .update(
        result.rows
          .map((r) => JSON.stringify(r.value))
          .sort()
          .join("\n"),
      )
      .digest("hex");
  }
  return hashes;
}
it("restores all application tables, image bytes, article revisions, files and the original recovery key into a new root", async () => {
  const f = await fixture(),
    before = await digest(raw!),
    result = await createSnapshot(raw!, {
      ...f,
      artifactRoots: [f.artifacts],
      engineVersion: runtime.version,
      password,
    });
  expect((await readFile(result.file)).includes(Buffer.from("fixture-password"))).toBe(false);
  expect((await readFile(result.file)).includes(Buffer.from(recoveryKey))).toBe(false);
  const restored = await restoreSnapshot({
    file: result.file,
    restoreRoot: f.restoreRoot,
    password,
    engineVersion: runtime.version,
    create: (dataDir, loadDataDir) => runtime.PGlite.create({ dataDir, loadDataDir }),
  });
  const opened = await runtime.PGlite.create(path.join(restored.directory, "pglite"));
  try {
    expect(await digest(opened)).toEqual(before);
    for (const [table, column] of [
      ["proposal_versions", "demo_artifact_dir"],
      ["delivery_versions", "artifact_dir"],
      ["site_audits", "artifact_dir"],
    ]) {
      const rows = await opened.query<{ directory: string }>(
        `select ${column} as directory from ${table} where ${column} is not null`,
      );
      for (const r of rows.rows) {
        expect(r.directory.startsWith(restored.directory + path.sep)).toBe(true);
        expect(await readFile(path.join(r.directory, "店舗写真.png"))).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]),
        );
        expect(await readFile(path.join(r.directory, "index.html"), "utf8")).toContain("復元したサイト");
      }
    }
    expect(await readFile(path.join(restored.directory, "share-token-key"), "utf8")).toBe(recoveryKey);
    expect(await digest(raw!)).toEqual(before);
  } finally {
    await opened.close();
  }
});
it("authenticates before opening the restored DB, rejects another engine version, and removes only its isolated attempt", async () => {
  const f = await fixture(),
    result = await createSnapshot(raw!, {
      ...f,
      artifactRoots: [f.artifacts],
      engineVersion: runtime.version,
      password,
    });
  let opened = false;
  const create = async (dataDir: string, loadDataDir: Blob) => {
    opened = true;
    return runtime.PGlite.create({ dataDir, loadDataDir });
  };
  await expect(
    restoreSnapshot({
      file: result.file,
      restoreRoot: f.restoreRoot,
      password: "wrong fixture password",
      engineVersion: runtime.version,
      create,
    }),
  ).rejects.toBeInstanceOf(BackupError);
  expect(opened).toBe(false);
  expect(await readdir(f.restoreRoot)).toEqual([]);
  await expect(
    restoreSnapshot({ file: result.file, restoreRoot: f.restoreRoot, password, engineVersion: "999.0.0", create }),
  ).rejects.toBeInstanceOf(BackupError);
  expect(opened).toBe(false);
  expect(await readdir(f.restoreRoot)).toEqual([]);
});
it("runs the real authenticated local control endpoint and releases the protocol lock after backup", async () => {
  const f = await fixture();
  server = await startPGliteServer(raw as Awaited<ReturnType<typeof runtime.PGlite.create>>, {
    host: "127.0.0.1",
    port: 0,
  });
  let stopped = false;
  control = await startBackupControl({
    db: raw!,
    server,
    dataRoot: f.dataRoot,
    backupRoot: f.backupRoot,
    artifactRoots: [f.artifacts],
    engineVersion: runtime.version,
    ownerNonce: lease!.owner.nonce,
    verify: (file, password, signal) =>
      verifySnapshot({
        file,
        restoreRoot: f.restoreRoot,
        password,
        signal,
        engineVersion: runtime.version,
        create: (dataDir, loadDataDir) => runtime.PGlite.create({ dataDir, loadDataDir }),
      }),
    stop: () => {
      stopped = true;
    },
  });
  const result = await requestControl(f.dataRoot, "backup", password);
  expect(result.file).toBeTruthy();
  expect(result.verification?.tables).toBeGreaterThan(20);
  expect(await readdir(f.restoreRoot)).toEqual([]);
  expect((await latestVerification(path.dirname(result.file!)))!.archiveSha256).toBe(
    createHash("sha256")
      .update(await readFile(result.file!))
      .digest("hex"),
  );
  expect((await raw!.query<{ n: number }>("select 1::int as n")).rows[0]!.n).toBe(1);
  const backupId = path.basename(path.dirname(result.file!));
  const verified = await requestControl(f.dataRoot, "verify", password, undefined, backupId);
  expect(verified.verification?.archiveSha256).toBe(result.verification?.archiveSha256);
  expect((await readdir(path.dirname(result.file!))).filter((n) => n.startsWith("verification-")).length).toBe(2);
  await expect(
    requestControl(f.dataRoot, "verify", "wrong fixture passphrase", undefined, backupId),
  ).rejects.toBeInstanceOf(BackupError);
  await expect(requestControl(f.dataRoot, "verify", password, undefined, "../escape")).rejects.toBeInstanceOf(
    BackupError,
  );
  expect(await readdir(f.restoreRoot)).toEqual([]);
  await requestControl(f.dataRoot, "stop");
  await new Promise((r) => setTimeout(r, 20));
  expect(stopped).toBe(true);
});
it("keeps the protocol available while encrypting and preserves the database point captured before later writes", async () => {
  const f = await fixture();
  await host(f);
  const entered = deferred(),
    resume = deferred(),
    original = bundle.writeBundle;
  const before = await digest(raw!);
  vi.spyOn(bundle, "writeBundle").mockImplementation(async (...args) => {
    entered.resolve();
    await resume.promise;
    return original(...args);
  });
  const work = requestControl(f.dataRoot, "backup", password);
  void work.catch(() => {});
  const fromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const { Client } = fromDb("pg") as {
    Client: new (options: {
      connectionString: string;
      query_timeout: number;
    }) => { connect(): Promise<void>; query(text: string): Promise<unknown>; end(): Promise<void> };
  };
  const client = new Client({
    connectionString: `postgres://postgres@127.0.0.1:${server!.port}/postgres`,
    query_timeout: 2000,
  });
  try {
    await entered.promise;
    expect((await requestControl(f.dataRoot, "status")).status).toMatchObject({
      busy: true,
      phase: "encrypt",
      operation: "backup",
    });
    await client.connect();
    await client.query("update public.companies set name='保存開始後に更新した架空会社'");
  } finally {
    resume.resolve();
    await client.end();
  }
  const result = await work;
  const restored = await restoreSnapshot({
    file: result.file!,
    password,
    restoreRoot: f.restoreRoot,
    engineVersion: runtime.version,
    create: (dataDir, loadDataDir) => runtime.PGlite.create({ dataDir, loadDataDir }),
  });
  const opened = await runtime.PGlite.create(path.join(restored.directory, "pglite"));
  try {
    expect(await digest(opened)).toEqual(before);
    expect(await digest(raw!)).not.toEqual(before);
  } finally {
    await opened.close();
  }
  expect((await requestControl(f.dataRoot, "status")).status?.busy).toBe(false);
});
it("cancels verification on shutdown, leaves a recoverable encrypted file, and can reverify it after reconnecting", async () => {
  const f = await fixture(),
    entered = deferred();
  await host(f, async (_file, _password, signal) => {
    entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    throw new Error("unreachable");
  });
  const outcome = requestControl(f.dataRoot, "backup", password).then(
    () => "unexpected-success",
    () => "disconnected",
  );
  await entered.promise;
  const status = (await requestControl(f.dataRoot, "status")).status;
  expect(status).toMatchObject({ busy: true, operation: "backup", phase: "verify" });
  expect(JSON.stringify(status)).not.toContain(password);
  expect(JSON.stringify(status)).not.toContain(f.dataRoot);
  await expect(requestControl(f.dataRoot, "backup", password)).rejects.toThrow("進行中");
  await Promise.all([control!.stop(), control!.stop()]);
  control = undefined;
  expect(await outcome).toBe("disconnected");
  const names = (await readdir(f.backupRoot)).filter((n) => n.startsWith("backup-"));
  expect(names).toHaveLength(1);
  expect(await latestVerification(path.join(f.backupRoot, names[0]!))).toBeNull();
  await host(f);
  const result = await requestControl(f.dataRoot, "verify", password, undefined, names[0]);
  expect(result.verification?.tables).toBeGreaterThan(20);
  expect(await readdir(f.restoreRoot)).toEqual([]);
});
it("includes durable schemas with names similar to temporary schemas in the verification inventory", async () => {
  const f = await fixture();
  await raw!.query("create schema pgxtempyarchive");
  await raw!.query("create table pgxtempyarchive.entries (id integer primary key, label text not null)");
  await raw!.query("insert into pgxtempyarchive.entries values (1, '保管対象のデータ')");
  const snapshot = await captureDatabase(raw!);
  expect(snapshot.tables.find((t) => t.schema === "pgxtempyarchive" && t.name === "entries")?.rows).toBe(1);
  const result = await saveSnapshot(snapshot, {
    ...f,
    artifactRoots: [f.artifacts],
    engineVersion: runtime.version,
    password,
  });
  const restored = await restoreSnapshot({
    file: result.file,
    password,
    restoreRoot: f.restoreRoot,
    engineVersion: runtime.version,
    create: (dataDir, loadDataDir) => runtime.PGlite.create({ dataDir, loadDataDir }),
  });
  const opened = await runtime.PGlite.create(path.join(restored.directory, "pglite"));
  try {
    expect((await opened.query<{ label: string }>("select label from pgxtempyarchive.entries")).rows[0]!.label).toBe(
      "保管対象のデータ",
    );
  } finally {
    await opened.close();
  }
});
