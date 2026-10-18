import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensurePlainDirectory, removeOwnedDirectory } from "../../../../demo/backup/bundle.ts";

vi.mock("./backups", () => ({
  BackupAccessError: class extends Error {
    status: number;
    constructor(status: number) {
      super("denied");
      this.status = status;
    }
  },
  requireBackupOps: vi.fn(),
  backupEnvironment: vi.fn(),
  backupAudit: vi.fn(),
}));

import { byteRange, downloadBackup } from "./backup-download";
import { BackupAccessError, backupAudit, backupEnvironment, requireBackupOps } from "./backups";

const parent = path.resolve(".data/local-run/backup-download");
let root = "",
  id = "";
const body = Buffer.from("SiteOffer encrypted backup fixture\0日本語", "utf8");
beforeEach(async () => {
  vi.resetAllMocks();
  await ensurePlainDirectory(parent);
  root = path.join(parent, `backup-${randomUUID()}`);
  await mkdir(root);
  id = `backup-${randomUUID()}`;
  await mkdir(path.join(root, id));
  await writeFile(path.join(root, id, "backup.sob"), body);
  vi.mocked(backupEnvironment).mockReturnValue({ dataRoot: root, backupRoot: root });
  vi.mocked(requireBackupOps).mockResolvedValue({ kind: "ops", userId: randomUUID() });
});
afterEach(async () => {
  await removeOwnedDirectory(root, parent);
});
it("streams exact bytes with private headers, supports ranges and HEAD, and rejects unsatisfiable ranges", async () => {
  const res = await downloadBackup(new Request("http://localhost/file"), id);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("vary")).toBe("Cookie");
  expect(res.headers.get("content-disposition")).toContain("attachment;");
  const received = Buffer.from(await res.arrayBuffer());
  expect(createHash("sha256").update(received).digest("hex")).toBe(createHash("sha256").update(body).digest("hex"));
  const range = await downloadBackup(new Request("http://localhost/file", { headers: { Range: "bytes=4-10" } }), id);
  expect(range.status).toBe(206);
  expect(Buffer.from(await range.arrayBuffer())).toEqual(body.subarray(4, 11));
  expect(range.headers.get("content-range")).toBe(`bytes 4-10/${body.length}`);
  const head = await downloadBackup(new Request("http://localhost/file", { method: "HEAD" }), id, true);
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(Number(head.headers.get("content-length"))).toBe(body.length);
  const invalid = await downloadBackup(
    new Request("http://localhost/file", { headers: { Range: "bytes=999999-" } }),
    id,
  );
  expect(invalid.status).toBe(416);
  expect(await invalid.text()).toBe("");
  expect(vi.mocked(backupAudit).mock.calls.length).toBe(2);
});
it("rechecks authorization before any file bytes and refuses path traversal", async () => {
  vi.mocked(requireBackupOps).mockRejectedValueOnce(new BackupAccessError(401));
  expect((await downloadBackup(new Request("http://localhost/file"), id)).status).toBe(401);
  vi.mocked(requireBackupOps)
    .mockResolvedValueOnce({ kind: "ops", userId: randomUUID() })
    .mockRejectedValueOnce(new BackupAccessError(403));
  const revoked = await downloadBackup(new Request("http://localhost/file"), id);
  expect(revoked.status).toBe(403);
  expect(await revoked.text()).toBe("Not Found");
  vi.mocked(requireBackupOps).mockResolvedValue({ kind: "ops", userId: randomUUID() });
  expect((await downloadBackup(new Request("http://localhost/file"), "../users.json")).status).toBe(404);
  expect(backupAudit).not.toHaveBeenCalled();
});
it("parses suffix/open ranges and rejects ambiguous or unsafe values", () => {
  expect(byteRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
  expect(byteRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
  for (const value of ["bytes=-0", "bytes=2-1", "bytes=0-1,4-5", "bytes=9007199254740992-", "bytes=-", "items=0-1"])
    expect(byteRange(value, 10)).toBe(false);
});
