import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensurePlainDirectory, removeOwnedDirectory } from "./bundle.ts";
import { parseRetentionRequest, runRetention } from "./retention-service.ts";

const parent = path.resolve(".data/local-run/retention-protocol-tests");
let root: string | undefined;
afterEach(async () => {
  if (root) await removeOwnedDirectory(root, parent);
  root = undefined;
});
it("rejects malformed operations, path escape, invalid pages and boolean impersonation", () => {
  const id = `backup-${randomUUID()}`;
  for (const raw of [
    null,
    "storage",
    {},
    { operation: "storage", page: -1 },
    { operation: "storage", batch: "../outside" },
    { operation: "pin", id, pinned: "true" },
    { operation: "purge", id, keeper: "../outside" },
    { operation: "move", token: "a".repeat(64), policy: { keepCount: 0, ageDays: 30 } },
    { operation: "plan", policy: { keepCount: 1, ageDays: -1 } },
  ])
    expect(() => parseRetentionRequest(raw)).toThrow();
  expect(
    parseRetentionRequest({
      operation: "plan",
      policy: { keepCount: 1, ageDays: 0 },
      directory: "ignored outside path",
    }),
  ).toEqual({ operation: "plan", policy: { keepCount: 1, ageDays: 0 } });
});
it("pages all entries, bounds a preview to 100 and keeps wire replies below the control limit", async () => {
  await ensurePlainDirectory(parent);
  root = path.join(parent, `backup-${randomUUID()}`);
  await mkdir(root);
  for (let i = 0; i < 121; i++) {
    const directory = path.join(root, `backup-${randomUUID()}`);
    await mkdir(directory);
    await writeFile(path.join(directory, "backup.sob"), `fixture ${i}`);
  }
  const verify = async () => ({ archiveSha256: "a".repeat(64) });
  const first = await runRetention(root, { operation: "storage" }, undefined, verify),
    last = await runRetention(root, { operation: "storage", page: 6 }, undefined, verify);
  if (first.kind !== "storage" || last.kind !== "storage") throw Error("Expected storage pages");
  expect(first.active.total).toBe(121);
  expect(first.active.items).toHaveLength(20);
  expect(last.active.items).toHaveLength(1);
  const preview = await runRetention(
    root,
    { operation: "plan", policy: { keepCount: 1, ageDays: 0 } },
    undefined,
    verify,
    undefined,
    new Date(Date.now() + 1000),
  );
  if (preview.kind !== "plan") throw Error("Expected plan");
  expect(preview.plan.candidates).toHaveLength(100);
  expect(preview.plan.eligible).toBe(120);
  expect(preview.plan.preserved).toBe(21);
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(65536);
  expect(JSON.stringify(preview)).not.toContain('"ino"');
});
