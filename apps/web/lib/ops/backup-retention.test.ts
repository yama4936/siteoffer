import { randomUUID } from "node:crypto";
import path from "node:path";
import { auditEvents, type Db, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("../session", () => ({ getCurrentActor: vi.fn() }));
vi.mock("../../../../demo/backup/control-client.ts", () => ({ requestControl: vi.fn() }));

import { requestControl } from "../../../../demo/backup/control-client.ts";
import { getDb } from "../db";
import { getCurrentActor } from "../session";
import { readBackupStorage, retentionOperation } from "./backup-retention";
import { seedUser } from "./test-seed";

let db: Db, close: () => Promise<void>;
const id = `backup-${randomUUID()}`,
  keeper = `backup-${randomUUID()}`,
  phrase = "架空の保管整理パスフレーズ";
const idle = { available: true, busy: false, operation: null, phase: null, startedAt: null, files: 0 } as const;
beforeEach(async () => {
  vi.resetAllMocks();
  ({ db, close } = await createTestDb());
  vi.mocked(getDb).mockReturnValue(db);
  vi.stubEnv("SITEOFFER_BACKUP_DATA_ROOT", path.resolve(".data/retention-test-data"));
  vi.stubEnv("SITEOFFER_BACKUP_ROOT", path.resolve(".data/retention-test-files"));
});
afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});
it("refuses anonymous, non-ops, impersonation and suspension before invoking host operations", async () => {
  vi.mocked(getCurrentActor).mockResolvedValue(null);
  await expect(retentionOperation({ operation: "storage" })).rejects.toMatchObject({ status: 401 });
  const sales = await seedUser(db, "sales");
  vi.mocked(getCurrentActor).mockResolvedValue(sales.actor);
  await expect(retentionOperation({ operation: "plan", policy: { keepCount: 1, ageDays: 0 } })).rejects.toMatchObject({
    status: 403,
  });
  vi.mocked(getCurrentActor).mockResolvedValue({ kind: "ops", userId: sales.user.id });
  await expect(retentionOperation({ operation: "restore", id })).rejects.toMatchObject({ status: 403 });
  const ops = await seedUser(db, "ops");
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, ops.user.id));
  vi.mocked(getCurrentActor).mockResolvedValue(ops.actor);
  await expect(readBackupStorage()).rejects.toMatchObject({ status: 403 });
  expect(requestControl).not.toHaveBeenCalled();
});
it("requires explicit confirmation and a bounded purge phrase before accepting a mutation", async () => {
  const ops = await seedUser(db, "ops");
  vi.mocked(getCurrentActor).mockResolvedValue(ops.actor);
  await expect(
    retentionOperation({ operation: "move", policy: { keepCount: 1, ageDays: 0 }, token: "a".repeat(64) }),
  ).rejects.toThrow("確認欄");
  await expect(retentionOperation({ operation: "purge", id, keeper }, phrase)).rejects.toThrow("確認欄");
  await expect(retentionOperation({ operation: "purge", id, keeper }, "short", true)).rejects.toThrow("パスフレーズ");
  expect(requestControl).not.toHaveBeenCalled();
  expect(await db.select().from(auditEvents)).toEqual([]);
});
it("passes the authenticated requester to the host and records no secret on failures", async () => {
  const ops = await seedUser(db, "ops");
  vi.mocked(getCurrentActor).mockResolvedValue(ops.actor);
  vi.mocked(requestControl).mockRejectedValue(new Error("simulated host failure"));
  await expect(retentionOperation({ operation: "purge", id, keeper }, phrase, true)).rejects.toThrow();
  expect(requestControl).toHaveBeenCalledWith(
    path.resolve(".data/retention-test-data"),
    "retention",
    phrase,
    undefined,
    undefined,
    { operation: "purge", id, keeper },
    ops.user.id,
  );
  const events = await db.select().from(auditEvents);
  expect(events.map((row) => row.action)).toEqual([
    "backup.retention.purge.requested",
    "backup.retention.purge.failed",
  ]);
  expect(JSON.stringify(events)).not.toContain(phrase);
  expect(events.every((row) => !!row.targetId)).toBe(true);
});
it("checks the current role after a long operation and records its actual completion", async () => {
  const ops = await seedUser(db, "ops");
  vi.mocked(getCurrentActor).mockResolvedValue(ops.actor);
  vi.mocked(requestControl).mockImplementation(async () => {
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, ops.user.id));
    return { retention: { kind: "pinned" } };
  });
  await expect(retentionOperation({ operation: "pin", id, pinned: true })).rejects.toMatchObject({ status: 403 });
  expect((await db.select().from(auditEvents)).map((row) => row.action)).toEqual([
    "backup.retention.pin.requested",
    "backup.retention.pin.completed",
  ]);
});
it("keeps missing configuration and busy hosts distinct from an empty or completed storage view", async () => {
  const ops = await seedUser(db, "ops");
  vi.mocked(getCurrentActor).mockResolvedValue(ops.actor);
  vi.stubEnv("SITEOFFER_BACKUP_DATA_ROOT", "");
  expect(await readBackupStorage()).toMatchObject({ configured: false, data: null });
  expect(requestControl).not.toHaveBeenCalled();
  vi.stubEnv("SITEOFFER_BACKUP_DATA_ROOT", path.resolve(".data/retention-test-data"));
  vi.mocked(requestControl).mockResolvedValue({
    status: { ...idle, busy: true, operation: "retention", phase: "retention", startedAt: new Date().toISOString() },
  });
  expect(await readBackupStorage()).toMatchObject({
    configured: true,
    data: null,
    runtime: { available: true, busy: true },
  });
  expect(await db.select().from(auditEvents)).toEqual([]);
});
