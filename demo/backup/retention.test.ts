import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensurePlainDirectory, removeOwnedDirectory } from "./bundle.ts";
import { backupFile } from "./catalog.ts";
import {
  backupStorage,
  moveRetention,
  pinBackup,
  planRetention,
  purgeRetention,
  restoreRetention,
  retentionPolicy,
} from "./retention.ts";

const parent = path.resolve(".data/local-run/backup-retention-tests"),
  owned: string[] = [];
const future = () => new Date(Date.now() + 45 * 86400000),
  policy = { keepCount: 1, ageDays: 30 };
afterEach(async () => {
  for (const directory of owned.splice(0)) await removeOwnedDirectory(directory, parent);
});
async function fixture(count = 4) {
  await ensurePlainDirectory(parent);
  const root = path.join(parent, `backup-${randomUUID()}`);
  await mkdir(root);
  owned.push(root);
  for (let i = 0; i < count; i++) {
    const id = `backup-${randomUUID()}`,
      directory = path.join(root, id);
    await mkdir(directory);
    await writeFile(path.join(directory, "backup.sob"), `encrypted fixture ${i}`);
    const { info } = await backupFile(root, id);
    await writeFile(
      path.join(directory, `verification-${randomUUID()}.json`),
      JSON.stringify({
        format: 1,
        verifiedAt: new Date().toISOString(),
        archiveBytes: info.size,
        archiveMtimeMs: info.mtimeMs,
        archiveSha256: "a".repeat(64),
        files: 2,
        references: 0,
        tables: 1,
      }),
    );
  }
  return root;
}
const verified = async () => ({ archiveSha256: "a".repeat(64) });
it("retries an empty reserved batch after a journal write fails before any archive moves", async () => {
  const root = await fixture(2),
    plan = await planRetention(root, policy, future());
  const probe = await open(path.join(root, "sync-probe"), "w"),
    prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const failure = vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("simulated journal sync failure"));
  try {
    await expect(moveRetention(root, policy, plan.token, future())).rejects.toThrow();
  } finally {
    failure.mockRestore();
  }
  expect((await backupStorage(root)).entries).toHaveLength(2);
  const retried = await moveRetention(root, policy, plan.token, future());
  expect(retried.state).toBe("moved");
  expect((await backupStorage(root)).blocked).toBe(0);
});
it("does not leave a backup blocked by its own temporary pin file after a durable-write failure", async () => {
  const root = await fixture(1),
    item = (await backupStorage(root)).entries[0]!;
  const probe = await open(path.join(root, "sync-probe"), "w"),
    prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const failure = vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("simulated durable write failure"));
  try {
    await expect(pinBackup(root, item.id, true)).rejects.toThrow();
  } finally {
    failure.mockRestore();
  }
  expect((await readdir(path.join(root, item.id))).some((name) => /^pin-.*\.tmp$/.test(name))).toBe(false);
  expect((await backupStorage(root)).blocked).toBe(0);
});
it("honors the explicit zero-day choice even when a copied archive has a future modification time", async () => {
  const root = await fixture(),
    entries = (await backupStorage(root)).entries;
  for (let index = 0; index < 2; index++) {
    const date = new Date(Date.now() + (100 - index) * 86400000);
    await utimes(path.join(root, entries[index]!.id, "backup.sob"), date, date);
  }
  const unlimited = await planRetention(root, { keepCount: 1, ageDays: 0 });
  expect(unlimited.candidates.map((item) => item.id)).toContain(entries[1]!.id);
  expect((await planRetention(root, { keepCount: 1, ageDays: 1 })).candidates.map((item) => item.id)).not.toContain(
    entries[1]!.id,
  );
});
it("closes a mixed restore and purge without reporting a ghost unfinished operation", async () => {
  const root = await fixture(3),
    plan = await planRetention(root, policy, future()),
    moved = await moveRetention(root, policy, plan.token, future());
  const restored = moved.items[0]!;
  await rename(path.join(root, "trash", moved.id, restored.entry.id), path.join(root, restored.entry.id));
  const result = await purgeRetention(root, moved.id, plan.keeper!, "test password", verified);
  expect(result.batch.state).toBe("closed");
  const storage = await backupStorage(root);
  expect(storage.blocked).toBe(0);
  expect(storage.entries).toHaveLength(2);
  expect(storage.trashBytes).toBe(0);
  expect(await readFile(path.join(root, restored.entry.id, "backup.sob"), "utf8")).toMatch(/encrypted fixture/);
});
it("keeps completed history valid after an interrupted restore, another move and later deletion", async () => {
  const root = await fixture(2),
    first = await planRetention(root, policy, future()),
    moved = await moveRetention(root, policy, first.token, future());
  const item = moved.items[0]!;
  await rename(path.join(root, "trash", moved.id, item.entry.id), path.join(root, item.entry.id));
  expect((await backupStorage(root)).batches[0]?.state).toBe("restored");
  const next = await planRetention(root, policy, future()),
    second = await moveRetention(root, policy, next.token, future());
  expect((await backupStorage(root)).blocked).toBe(0);
  expect(JSON.parse(await readFile(path.join(root, "trash", moved.id, "journal.json"), "utf8")).state).toBe("restored");
  await purgeRetention(root, second.id, next.keeper!, "test password", verified);
  const final = await backupStorage(root);
  expect(final.blocked).toBe(0);
  expect(final.batches).toHaveLength(2);
  expect(final.batches.find((batch) => batch.id === moved.id)?.state).toBe("restored");
});
it("stops before unlink after cancellation and can resume the recorded purge intent", async () => {
  const root = await fixture(),
    plan = await planRetention(root, policy, future()),
    batch = await moveRetention(root, policy, plan.token, future());
  const controller = new AbortController();
  let checks = 0;
  await expect(
    purgeRetention(root, batch.id, plan.keeper!, "test password", verified, controller.signal, async () => {
      if (++checks === 2) controller.abort();
    }),
  ).rejects.toThrow();
  for (const item of batch.items)
    expect(await readFile(path.join(root, "trash", batch.id, item.entry.id, "backup.sob"), "utf8")).toMatch(
      /encrypted fixture/,
    );
  expect((await purgeRetention(root, batch.id, plan.keeper!, "test password", verified)).removedBytes).toBe(plan.bytes);
});
it("plans by age while preserving newest copies, protected backups and measured bytes", async () => {
  const root = await fixture(),
    initial = await backupStorage(root);
  const protectedId = initial.entries[1]!.id;
  await pinBackup(root, protectedId, true);
  expect((await planRetention(root, policy)).candidates).toEqual([]);
  const plan = await planRetention(root, policy, future());
  expect(plan.candidates).toHaveLength(2);
  expect(plan.candidates.map((entry) => entry.id)).not.toContain(protectedId);
  expect(plan.candidates.map((entry) => entry.id)).not.toContain(initial.entries[0]!.id);
  expect(plan.bytes).toBe(plan.candidates.reduce((bytes, entry) => bytes + entry.bytes, 0));
  expect(plan.storage.activeBytes).toBeGreaterThan(plan.bytes);
  expect(typeof plan.storage.freeBytes).toBe("number");
  expect(() => retentionPolicy({ ageDays: 0, keepCount: 0 })).toThrow();
});
it("refuses a stale preview after changes and excludes shared files and directory junctions", async () => {
  const root = await fixture(),
    plan = await planRetention(root, policy, future());
  const first = plan.candidates[0]!;
  await pinBackup(root, first.id, true);
  await expect(moveRetention(root, policy, plan.token, future())).rejects.toThrow("変わりました");
  const sharedId = plan.candidates[1]!.id;
  const shared = path.join(root, sharedId, "backup.sob"),
    peer = path.join(root, "shared-sentinel");
  await link(shared, peer);
  const external = await fixture(0);
  await writeFile(path.join(external, "sentinel"), "keep");
  await symlink(external, path.join(root, `backup-${randomUUID()}`), "junction");
  const next = await planRetention(root, policy, future());
  expect(next.candidates.map((entry) => entry.id)).not.toContain(sharedId);
  expect(next.storage.blocked).toBeGreaterThanOrEqual(2);
  expect(await readFile(path.join(external, "sentinel"), "utf8")).toBe("keep");
  expect(await readFile(peer, "utf8")).toMatch(/encrypted fixture/);
});
it("moves once, can restore exactly, and never overwrites a reused original name", async () => {
  const root = await fixture(),
    plan = await planRetention(root, policy, future());
  const batch = await moveRetention(root, policy, plan.token, future());
  expect(batch.items.every((item) => item.state === "moved")).toBe(true);
  expect((await backupStorage(root)).trashBytes).toBe(plan.bytes);
  expect((await moveRetention(root, policy, plan.token, future())).id).toBe(batch.id);
  expect(await readdir(path.join(root, "trash"))).toEqual([batch.id]);
  const conflict = path.join(root, batch.items[0]!.entry.id);
  await mkdir(conflict);
  await expect(restoreRetention(root, batch.id)).rejects.toThrow();
  expect(await readdir(conflict)).toEqual([]);
  await import("node:fs/promises").then((fs) => fs.rmdir(conflict));
  const restored = await restoreRetention(root, batch.id);
  expect(restored.state).toBe("restored");
  const current = await backupStorage(root);
  expect(current.entries).toHaveLength(4);
  expect(current.trashBytes).toBe(0);
  for (const item of batch.items)
    expect(await readFile(path.join(root, item.entry.id, "backup.sob"), "utf8")).toMatch(/encrypted fixture/);
  expect((await planRetention(root, policy, future())).token).not.toBe(plan.token);
});
it("requires keeper verification before permanent deletion and preserves it after success", async () => {
  const root = await fixture(),
    plan = await planRetention(root, policy, future());
  const batch = await moveRetention(root, policy, plan.token, future());
  const reject = vi.fn(async () => {
    throw new Error("wrong phrase");
  });
  await expect(purgeRetention(root, batch.id, plan.keeper!, "wrong test password", reject)).rejects.toThrow();
  expect((await backupStorage(root)).trashBytes).toBe(plan.bytes);
  expect((await backupStorage(root)).batches[0]?.restorable).toBe(true);
  const result = await purgeRetention(root, batch.id, plan.keeper!, "test password", verified);
  expect(result.removedBytes).toBe(plan.bytes);
  expect(result.batch.state).toBe("purged");
  expect(result.freeBefore).not.toBeNull();
  expect(result.freeAfter).not.toBeNull();
  expect((await backupStorage(root)).entries.map((entry) => entry.id)).toEqual([plan.keeper]);
  expect((await backupStorage(root)).trashBytes).toBe(0);
  expect((await purgeRetention(root, batch.id, plan.keeper!, "test password", verified)).removedBytes).toBe(0);
});
it("detects modifications before calling the verifier or deleting any other batch files", async () => {
  const root = await fixture(),
    plan = await planRetention(root, policy, future()),
    batch = await moveRetention(root, policy, plan.token, future());
  const damaged = path.join(root, "trash", batch.id, batch.items[0]!.entry.id, "backup.sob");
  await writeFile(damaged, "changed");
  const verify = vi.fn(verified);
  await expect(purgeRetention(root, batch.id, plan.keeper!, "test password", verify)).rejects.toThrow();
  expect(verify).not.toHaveBeenCalled();
  expect(await readFile(damaged, "utf8")).toBe("changed");
  expect(await readFile(path.join(root, "trash", batch.id, batch.items[1]!.entry.id, "backup.sob"), "utf8")).toMatch(
    /encrypted fixture/,
  );
});
it("recovers rename-before-journal-update and unlink-before-journal-update interruptions", async () => {
  const root = await fixture(),
    plan = await planRetention(root, policy, future()),
    batch = await moveRetention(root, policy, plan.token, future());
  const record = path.join(root, "trash", batch.id, "journal.json");
  batch.items[0]!.state = "pending";
  await writeFile(record, JSON.stringify(batch));
  expect((await backupStorage(root)).batches[0]!.items[0]!.state).toBe("moved");
  const interrupted = JSON.parse(await readFile(record, "utf8"));
  interrupted.items[0].purging = true;
  interrupted.items[0].intents = ["backup.sob"];
  await writeFile(record, JSON.stringify(interrupted));
  await unlink(path.join(root, "trash", batch.id, interrupted.items[0].entry.id, "backup.sob"));
  expect((await backupStorage(root)).trashBytes).toBe(
    plan.bytes - interrupted.items[0].entry.files.find((file: { name: string }) => file.name === "backup.sob").bytes,
  );
  await expect(restoreRetention(root, batch.id)).rejects.toThrow("完全削除");
  const result = await purgeRetention(root, batch.id, plan.keeper!, "test password", verified);
  expect(result.batch.state).toBe("purged");
});
it("rejects forged path records and resolves restore-before-journal-update without overwriting", async () => {
  const root = await fixture(2),
    plan = await planRetention(root, policy, future()),
    batch = await moveRetention(root, policy, plan.token, future());
  const directory = path.join(root, "trash", batch.id),
    record = path.join(directory, "journal.json"),
    source = batch.items[0]!;
  const forged = structuredClone(batch);
  forged.items[0]!.entry.files[0]!.name = "../sentinel";
  await writeFile(record, JSON.stringify(forged));
  await expect(purgeRetention(root, batch.id, plan.keeper!, "test password", verified)).rejects.toThrow();
  await writeFile(record, JSON.stringify(batch));
  await rename(path.join(directory, source.entry.id), path.join(root, source.entry.id));
  expect((await backupStorage(root)).batches[0]!.state).toBe("restored");
  expect((await restoreRetention(root, batch.id)).state).toBe("restored");
});
