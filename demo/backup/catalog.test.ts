import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensurePlainDirectory, removeOwnedDirectory } from "./bundle.ts";
import { backupFile, listBackups } from "./catalog.ts";

const parent = path.resolve(".data/local-run/backup-catalog");
const owned: string[] = [];
afterEach(async () => {
  for (const dir of owned.splice(0)) await removeOwnedDirectory(dir, parent);
});
async function fixture() {
  await ensurePlainDirectory(parent);
  const root = path.join(parent, `backup-${randomUUID()}`);
  await mkdir(root);
  owned.push(root);
  return root;
}
it("lists all backups through pages and distinguishes unfinished, unverified, changed and verified files", async () => {
  const root = await fixture();
  for (let i = 0; i < 25; i++) {
    const dir = path.join(root, `backup-${randomUUID()}`);
    await mkdir(dir);
    if (i === 0) continue;
    await writeFile(path.join(dir, "backup.sob"), "encrypted fixture");
    if (i <= 2) {
      const { info } = await backupFile(root, path.basename(dir));
      await writeFile(
        path.join(dir, `verification-${randomUUID()}.json`),
        JSON.stringify({
          format: 1,
          verifiedAt: new Date().toISOString(),
          archiveBytes: info.size,
          archiveMtimeMs: info.mtimeMs + (i === 2 ? 1 : 0),
          archiveSha256: "a".repeat(64),
          files: 3,
          references: 1,
          tables: 25,
        }),
      );
    }
  }
  const a = await listBackups(root, 0),
    b = await listBackups(root, 1);
  expect(a.total).toBe(25);
  expect(a.pages).toBe(2);
  expect(a.items.length).toBe(20);
  expect(b.items.length).toBe(5);
  const all = [...a.items, ...b.items];
  expect(new Set(all.map((i) => i.id)).size).toBe(25);
  expect(all.filter((i) => i.status === "verified")).toHaveLength(1);
  expect(all.filter((i) => i.status === "changed")).toHaveLength(1);
  expect(all.filter((i) => i.status === "incomplete")).toHaveLength(1);
  expect((await listBackups(root, 999)).page).toBe(1);
});
it("rejects path escape and invalid pages without touching sibling files", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "sentinel"), "keep");
  await expect(backupFile(root, "../escape")).rejects.toThrow();
  await expect(listBackups(root, -1)).rejects.toThrow();
  expect(await readFile(path.join(root, "sentinel"), "utf8")).toBe("keep");
  expect(await readdir(root)).toEqual(["sentinel"]);
});
