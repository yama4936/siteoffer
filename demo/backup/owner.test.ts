import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BackupError, ensurePlainDirectory, removeOwnedDirectory } from "./bundle.ts";
import { acquireOwner, unlockStoppedOwner } from "./owner.ts";

const parent = path.resolve(".data/local-run/backup-owner");
let home: string;
beforeEach(async () => {
  await ensurePlainDirectory(parent);
  home = path.join(parent, `backup-${randomUUID()}`);
  await mkdir(home);
});
afterEach(async () => removeOwnedDirectory(home, parent));
it("prevents opening an in-use data root and permits a new owner only after release", async () => {
  const first = await acquireOwner(home);
  await expect(acquireOwner(home)).rejects.toBeInstanceOf(BackupError);
  await first.release();
  const next = await acquireOwner(home);
  expect(next.owner.nonce).not.toBe(first.owner.nonce);
  await next.release();
});
it("does not automatically discard a crash marker and recovers it only after the explicit stopped-owner check", async () => {
  await writeFile(path.join(home, "preserved.txt"), "preserved");
  await writeFile(
    path.join(home, "runtime-owner.json"),
    JSON.stringify({
      kind: "siteoffer-demo-owner-v1",
      pid: 2147483647,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    }),
  );
  await expect(acquireOwner(home)).rejects.toBeInstanceOf(BackupError);
  await unlockStoppedOwner(home);
  const next = await acquireOwner(home);
  await next.release();
  expect(await readFile(path.join(home, "preserved.txt"), "utf8")).toBe("preserved");
});
it("never unlocks a running owner", async () => {
  const owner = await acquireOwner(home);
  await expect(unlockStoppedOwner(home)).rejects.toBeInstanceOf(BackupError);
  await owner.release();
});
it("does not remove a reservation whose owner changed", async () => {
  const owner = await acquireOwner(home),
    changed = { ...owner.owner, nonce: randomUUID() };
  await writeFile(path.join(home, "runtime-owner.json"), JSON.stringify(changed));
  await expect(owner.release()).rejects.toBeInstanceOf(BackupError);
  expect(JSON.parse(await readFile(path.join(home, "runtime-owner.json"), "utf8")).nonce).toBe(changed.nonce);
});
