import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startPGliteServer } from "../../packages/db/src/pglite-server.ts";
import { ensurePlainDirectory, removeOwnedDirectory } from "./bundle.ts";
import { startBackupControl } from "./control.ts";
import { requestControl } from "./control-client.ts";
import { acquireOwner } from "./owner.ts";
import { parseRetentionRequest } from "./retention-service.ts";
import { pgliteRuntime } from "./runtime.ts";
import { createSnapshot } from "./snapshot.ts";
import { verifySnapshot } from "./verify.ts";

const parent = path.resolve(".data/local-run/retention-native-tests");
let home: string | undefined, cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  if (home) await removeOwnedDirectory(home, parent);
  home = undefined;
});
it("uses the live authenticated host, actual native restore, revocation guard and resumable retention", async () => {
  await ensurePlainDirectory(parent);
  home = path.join(parent, `backup-${randomUUID()}`);
  await mkdir(home);
  const dataRoot = await ensurePlainDirectory(path.join(home, "data")),
    backupRoot = await ensurePlainDirectory(path.join(home, "backups"));
  const artifacts = await ensurePlainDirectory(path.join(dataRoot, "artifacts")),
    restoreRoot = await ensurePlainDirectory(path.join(home, "verification"));
  await writeFile(path.join(dataRoot, "share-token-key"), Buffer.alloc(32, 7).toString("base64url"));
  await writeFile(path.join(dataRoot, "users.json"), JSON.stringify([{ email: "fixture@example.test" }]));
  for (let i = 0; i < 2; i++) {
    const directory = path.join(backupRoot, `backup-${randomUUID()}`);
    await mkdir(directory);
    await writeFile(path.join(directory, "backup.sob"), `old encrypted fixture ${i}`);
  }
  const runtime = pgliteRuntime(),
    raw = await runtime.PGlite.create(path.join(dataRoot, "pglite"));
  let control: Awaited<ReturnType<typeof startBackupControl>> | undefined,
    server: Awaited<ReturnType<typeof startPGliteServer>> | undefined;
  const lease = await acquireOwner(dataRoot),
    ops = randomUUID(),
    phrase = "native-retention-fixture-password";
  cleanup = async () => {
    await control?.stop();
    await server?.stop();
    await raw.close();
    await lease.release();
  };
  await raw.query("create table users(id uuid primary key, role text not null, status text not null)");
  await raw.query("insert into users values ($1,'ops','active')", [ops]);
  await raw.query("create table fixture_data(id integer primary key, label text)");
  await raw.query("insert into fixture_data values (1,'架空の保持するデータ')");
  await raw.query("create table proposal_versions(id uuid primary key, demo_artifact_dir text)");
  await raw.query("create table delivery_versions(id uuid primary key, artifact_dir text)");
  await raw.query("create table site_audits(id uuid primary key, artifact_dir text)");
  const snapshot = await createSnapshot(raw, {
    dataRoot,
    backupRoot,
    artifactRoots: [artifacts],
    engineVersion: runtime.version,
    password: phrase,
  });
  const verify = (file: string, password: string, signal?: AbortSignal) =>
    verifySnapshot({
      file,
      password,
      restoreRoot,
      engineVersion: runtime.version,
      signal,
      create: (dataDir, loadDataDir) => runtime.PGlite.create({ dataDir, loadDataDir }),
    });
  await verify(snapshot.file, phrase);
  server = await startPGliteServer(raw, { port: 0, host: "127.0.0.1" });
  let revoke = false;
  control = await startBackupControl({
    db: raw,
    server,
    dataRoot,
    backupRoot,
    artifactRoots: [artifacts],
    engineVersion: runtime.version,
    ownerNonce: lease.owner.nonce,
    stop: () => {},
    retentionNow: () => new Date(Date.now() + 45 * 86400000),
    verify: async (file, password, signal) => {
      const value = await verify(file, password, signal);
      if (revoke) await server!.exclusive(() => raw.query("update users set status='suspended' where id=$1", [ops]));
      return value;
    },
  });
  const call = async (request: unknown, password?: string, userId = ops) =>
    (await requestControl(dataRoot, "retention", password, undefined, undefined, request, userId)).retention!;
  await expect(call({ operation: "storage" }, undefined, randomUUID())).rejects.toThrow("利用権限");
  const planned = await call({ operation: "plan", policy: { keepCount: 1, ageDays: 30 } });
  if (planned.kind !== "plan") throw Error("Expected a retention plan");
  expect(planned.plan.candidates.length).toBeGreaterThan(0);
  const moved = await call({ operation: "move", policy: planned.plan.policy, token: planned.plan.token });
  if (moved.kind !== "moved") throw Error("Expected moved copies");
  const id = moved.batch.id,
    keeper = path.basename(path.dirname(snapshot.file));
  await expect(call({ operation: "purge", id, keeper }, "wrong fixture password")).rejects.toThrow();
  let storage = await call({ operation: "storage" });
  if (storage.kind !== "storage") throw Error("Expected storage");
  expect(storage.trashBytes).toBe(planned.plan.bytes);
  expect(storage.trash.items[0]?.restorable).toBe(true);
  revoke = true;
  await expect(call({ operation: "purge", id, keeper }, phrase)).rejects.toThrow("利用権限");
  await server.exclusive(() => raw.query("update users set status='active' where id=$1", [ops]));
  revoke = false;
  storage = await call({ operation: "storage" });
  if (storage.kind !== "storage") throw Error("Expected storage");
  expect(storage.trashBytes).toBe(planned.plan.bytes);
  expect(storage.trash.items[0]?.restorable).toBe(true);
  const purged = await call({ operation: "purge", id, keeper }, phrase);
  if (purged.kind !== "purged") throw Error("Expected permanent deletion");
  expect(purged.removedBytes).toBe(planned.plan.bytes);
  expect(await readFile(snapshot.file)).not.toHaveLength(0);
  expect(
    (await server.exclusive(() => raw.query<{ label: string }>("select label from fixture_data"))).rows[0]?.label,
  ).toBe("架空の保持するデータ");
  expect(await readdir(restoreRoot)).toEqual([]);
  const record = await readFile(path.join(backupRoot, "trash", id, "journal.json"), "utf8");
  expect(record).not.toContain(phrase);
  expect(() =>
    parseRetentionRequest({ operation: "move", token: "../outside", policy: { keepCount: 0, ageDays: 0 } }),
  ).toThrow();
}, 60000);
