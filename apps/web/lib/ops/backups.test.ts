import { randomUUID } from "node:crypto";
import path from "node:path";
import { auditEvents, type Db, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("../session", () => ({ getCurrentActor: vi.fn() }));
vi.mock("../../../../demo/backup/control-client.ts", () => ({ readControl: vi.fn(), requestControl: vi.fn() }));

import { requestControl } from "../../../../demo/backup/control-client.ts";
import { getDb } from "../db";
import { getCurrentActor } from "../session";
import { backupPage, backupRuntimeStatus, requireBackupOps, runBackupOperation } from "./backups";
import { seedUser } from "./test-seed";

let db: Db, close: () => Promise<void>;
const phrase = "テスト用の架空パスフレーズです",
  id = `backup-${randomUUID()}`;
beforeEach(async () => {
  vi.resetAllMocks();
  ({ db, close } = await createTestDb());
  vi.mocked(getDb).mockReturnValue(db);
  vi.stubEnv("SITEOFFER_BACKUP_DATA_ROOT", path.resolve(".data/backup-test-data"));
  vi.stubEnv("SITEOFFER_BACKUP_ROOT", path.resolve(".data/backup-test-exports"));
});
afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});
it("refuses anonymous, sales, forged ops and suspended ops before reading files or invoking control", async () => {
  vi.mocked(getCurrentActor).mockResolvedValue(null);
  await expect(backupPage(0)).rejects.toMatchObject({ status: 401 });
  const sales = await seedUser(db, "sales");
  vi.mocked(getCurrentActor).mockResolvedValue(sales.actor);
  await expect(runBackupOperation("backup", phrase, phrase)).rejects.toMatchObject({ status: 403 });
  vi.mocked(getCurrentActor).mockResolvedValue({ kind: "ops", userId: sales.user.id });
  await expect(requireBackupOps()).rejects.toMatchObject({ status: 403 });
  const ops = await seedUser(db, "ops");
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, ops.user.id));
  vi.mocked(getCurrentActor).mockResolvedValue(ops.actor);
  await expect(backupPage(0)).rejects.toMatchObject({ status: 403 });
  expect(requestControl).not.toHaveBeenCalled();
  expect(await db.select().from(auditEvents)).toEqual([]);
});
it("records request and verified outcome without passphrases or control credentials", async () => {
  const ops = await seedUser(db, "ops");
  vi.mocked(getCurrentActor).mockResolvedValue(ops.actor);
  vi.mocked(requestControl).mockResolvedValue({
    file: path.join(process.env.SITEOFFER_BACKUP_ROOT!, id, "backup.sob"),
    bytes: 100,
    verification: {
      format: 1,
      verifiedAt: new Date().toISOString(),
      backupCreatedAt: new Date().toISOString(),
      engineVersion: "0.5.9",
      files: 3,
      references: 1,
      tables: 63,
      archiveSha256: "a".repeat(64),
      archiveBytes: 100,
      archiveMtimeMs: 1,
    },
  });
  expect(await runBackupOperation("backup", phrase, phrase, "")).toBe(id);
  const events = await db.select().from(auditEvents);
  expect(events.map((e) => e.action)).toEqual(["backup.backup.requested", "backup.backup.verified"]);
  expect(events[0]?.actorId).toBe(ops.user.id);
  expect(events[0]?.targetId).toMatch(/^[a-f0-9-]{36}$/);
  expect(events[1]?.actorKind).toBe("system");
  expect(JSON.stringify(events)).not.toContain(phrase);
});
it("keeps failure auditable and rechecks a revoked operator after a long-running operation", async () => {
  const ops = await seedUser(db, "ops");
  vi.mocked(getCurrentActor).mockResolvedValue(ops.actor);
  vi.mocked(requestControl).mockRejectedValueOnce(new Error("private internal failure"));
  await expect(runBackupOperation("verify", phrase, null, id)).rejects.toThrow();
  expect((await db.select().from(auditEvents)).map((e) => e.action)).toEqual([
    "backup.verify.requested",
    "backup.verify.failed",
  ]);
  vi.mocked(requestControl).mockImplementationOnce(async () => {
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, ops.user.id));
    return {
      file: path.join(process.env.SITEOFFER_BACKUP_ROOT!, id, "backup.sob"),
      verification: {
        format: 1,
        verifiedAt: new Date().toISOString(),
        backupCreatedAt: new Date().toISOString(),
        engineVersion: "0.5.9",
        files: 3,
        references: 1,
        tables: 63,
        archiveSha256: "a".repeat(64),
        archiveBytes: 100,
        archiveMtimeMs: 1,
      },
    };
  });
  await expect(runBackupOperation("verify", phrase, null, id)).rejects.toMatchObject({ status: 403 });
  const serialized = JSON.stringify(await db.select().from(auditEvents));
  expect(serialized).not.toContain(phrase);
  expect(serialized).not.toContain("private internal failure");
});
it("rejects mismatched phrases and invalid verification targets without starting a job", async () => {
  const ops = await seedUser(db, "ops");
  vi.mocked(getCurrentActor).mockResolvedValue(ops.actor);
  await expect(runBackupOperation("backup", phrase, "different")).rejects.toThrow("一致");
  await expect(runBackupOperation("verify", phrase, null, "../escape")).rejects.toThrow("選び直");
  expect(requestControl).not.toHaveBeenCalled();
});
it("reports actual host status without starting a backup and preserves unavailable rather than inventing completion", async () => {
  const ops = await seedUser(db, "ops");
  vi.mocked(getCurrentActor).mockResolvedValue(ops.actor);
  const status = {
    busy: true,
    operation: "backup" as const,
    phase: "encrypt" as const,
    startedAt: new Date().toISOString(),
    files: 5,
  };
  vi.mocked(requestControl).mockResolvedValueOnce({ status });
  expect(await backupRuntimeStatus()).toEqual({ ...status, available: true });
  expect(requestControl).toHaveBeenCalledWith(process.env.SITEOFFER_BACKUP_DATA_ROOT, "status");
  vi.mocked(requestControl).mockRejectedValueOnce(new Error("unavailable"));
  expect((await backupRuntimeStatus()).available).toBe(false);
  expect(await db.select().from(auditEvents)).toEqual([]);
});
