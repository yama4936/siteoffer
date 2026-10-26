import { randomUUID } from "node:crypto";
import {
  assignments,
  auditEvents,
  consultationCases,
  consultationDrafts,
  consultationEvents,
  type Db,
  salesActivities,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import { getConsultationCase, listConsultationCases, updateConsultationCase } from "./consultation.ts";
import {
  ConsultationDraftConflict,
  type ConsultationDraftValues,
  loadConsultationDraft,
  saveConsultationDraft,
  submitConsultationDraft,
} from "./consultation-drafts.ts";
import { seedBase, seedUser } from "./contract/test-seed.ts";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-16T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
async function seed(consultOps = true) {
  const b = await seedBase(db);
  const [activity] = await db
    .insert(salesActivities)
    .values({
      assignmentId: b.assignment.id,
      companyId: b.company.id,
      userId: b.sales.id,
      kind: "negotiating",
      occurredAt: clock.now(),
      consultOps,
      note: "公開済みの相談",
    })
    .returning();
  return { ...b, activity: activity! };
}
const values = (note = "未送信の回答", caseRevision = "0"): ConsultationDraftValues => ({
  note,
  mode: "resolve",
  caseRevision,
});
it("本人専用の下書きを復元し、相談履歴・他人の下書き・操作ログには出さない", async () => {
  const b = await seed();
  expect(await loadConsultationDraft(db, b.opsActor, b.activity.id)).toEqual({
    revision: 0,
    values: null,
    updatedAt: null,
  });
  const first = await saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 0, values());
  expect(await loadConsultationDraft(db, b.opsActor, b.activity.id)).toEqual(first);
  expect((await loadConsultationDraft(db, b.salesActor, b.activity.id)).values).toBeNull();
  const other = await seedUser(db, "ops");
  expect((await loadConsultationDraft(db, { kind: "ops", userId: other.id }, b.activity.id)).values).toBeNull();
  expect(JSON.stringify(await getConsultationCase(db, b.salesActor, b.activity.id))).not.toContain("未送信の回答");
  expect(await db.select().from(consultationEvents)).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
it("古いタブからの保存を競合として返し、破棄後も版を残して復活を防ぐ", async () => {
  const b = await seed();
  const saved = await saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 0, values("新しい下書き"));
  await expect(
    saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 0, values("古いタブ")),
  ).rejects.toMatchObject({ snapshot: saved });
  const deleted = await saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 1, null);
  expect(deleted).toMatchObject({ revision: 2, values: null });
  await expect(saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 1, values())).rejects.toBeInstanceOf(
    ConsultationDraftConflict,
  );
  expect((await loadConsultationDraft(db, b.opsActor, b.activity.id)).values).toBeNull();
});
it("同じ版の同時保存は片方だけを保存する", async () => {
  const b = await seed();
  const results = await Promise.allSettled([
    saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 0, values("A")),
    saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 0, values("B")),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect((await loadConsultationDraft(db, b.opsActor, b.activity.id)).revision).toBe(1);
});
it("送信と本人の下書き消去を確定し、相手の下書きを残す", async () => {
  const b = await seed();
  await saveConsultationDraft(db, clock, b.salesActor, b.activity.id, 0, values("営業の追記"));
  await saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 0, values());
  const r = await submitConsultationDraft(db, clock, b.opsActor, b.activity.id, {
    revision: 1,
    values: values(),
    operation: "resolve",
    requestKey: randomUUID(),
  });
  expect(r).toMatchObject({
    revision: 1,
    status: "resolved",
    replayed: false,
    snapshot: { revision: 2, values: null },
  });
  expect((await loadConsultationDraft(db, b.salesActor, b.activity.id)).values?.note).toBe("営業の追記");
  expect(await db.select().from(consultationEvents)).toHaveLength(1);
  expect(await db.select().from(auditEvents)).toHaveLength(1);
  await expect(saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 1, values())).rejects.toBeInstanceOf(
    ConsultationDraftConflict,
  );
});
it("送信応答を失って再試行しても二重記録せず、後で作った下書きも消さない", async () => {
  const b = await seed();
  const input = { revision: 0, values: values(), operation: "resolve" as const, requestKey: randomUUID() };
  const first = await submitConsultationDraft(db, clock, b.opsActor, b.activity.id, input);
  const next = await saveConsultationDraft(
    db,
    clock,
    b.opsActor,
    b.activity.id,
    first.snapshot.revision,
    values("次の未送信文", "1"),
  );
  const replay = await submitConsultationDraft(db, clock, b.opsActor, b.activity.id, input);
  expect(replay).toMatchObject({ replayed: true, snapshot: next });
  expect(await db.select().from(consultationEvents)).toHaveLength(1);
  await expect(
    submitConsultationDraft(db, clock, b.opsActor, b.activity.id, { ...input, values: values("変えた本文") }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(await loadConsultationDraft(db, b.opsActor, b.activity.id)).toEqual(next);
});
it("下書き・相談履歴・担当の競合を送信時にも確認し、入力を残す", async () => {
  const b = await seed();
  const saved = await saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 0, values());
  await expect(
    submitConsultationDraft(db, clock, b.opsActor, b.activity.id, {
      revision: 0,
      values: values(),
      operation: "resolve",
      requestKey: randomUUID(),
    }),
  ).rejects.toBeInstanceOf(ConsultationDraftConflict);
  const other = await seedUser(db, "ops");
  await updateConsultationCase(
    db,
    clock,
    { kind: "ops", userId: other.id },
    { activityId: b.activity.id, revision: 0, operation: "take", note: "", requestKey: randomUUID() },
  );
  await expect(
    submitConsultationDraft(db, clock, b.opsActor, b.activity.id, {
      revision: 1,
      values: values(),
      operation: "resolve",
      requestKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  const latest = await saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 1, values("未送信の回答", "1"));
  await expect(
    submitConsultationDraft(db, clock, b.opsActor, b.activity.id, {
      revision: latest.revision,
      values: latest.values,
      operation: "resolve",
      requestKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "assigned_elsewhere" });
  expect((await loadConsultationDraft(db, b.opsActor, b.activity.id)).values?.note).toBe(saved.values?.note);
  expect(await db.select().from(consultationEvents)).toHaveLength(1);
});
it("営業は終了した担当でも追加相談の下書きを保存・送信でき、運営操作はできない", async () => {
  const b = await seed();
  await db.update(assignments).set({ status: "completed" }).where(eq(assignments.id, b.assignment.id));
  const saved = await saveConsultationDraft(db, clock, b.salesActor, b.activity.id, 0, values("追加確認"));
  await expect(
    submitConsultationDraft(db, clock, b.salesActor, b.activity.id, {
      revision: 1,
      values: saved.values,
      operation: "resolve",
      requestKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  const result = await submitConsultationDraft(db, clock, b.salesActor, b.activity.id, {
    revision: 1,
    values: saved.values,
    operation: "follow_up",
    requestKey: randomUUID(),
  });
  expect(result.snapshot.values).toBeNull();
});
it("無関係な営業・通常活動・利用停止・不正な役割の読み書きを拒否する", async () => {
  const b = await seed();
  const normal = await seed(false);
  for (const [actor, id] of [
    [b.otherSalesActor, b.activity.id],
    [normal.opsActor, normal.activity.id],
    [null, b.activity.id],
    [{ kind: "sales" as const, userId: b.ops.id }, b.activity.id],
  ] as const) {
    await expect(loadConsultationDraft(db, actor, id)).rejects.toBeInstanceOf(Error);
    await expect(saveConsultationDraft(db, clock, actor, id, 0, values())).rejects.toBeInstanceOf(Error);
    await expect(
      submitConsultationDraft(db, clock, actor, id, {
        revision: 0,
        values: values(),
        operation: "resolve",
        requestKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(Error);
  }
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, b.ops.id));
  await expect(loadConsultationDraft(db, b.opsActor, b.activity.id)).rejects.toMatchObject({ code: "forbidden" });
  await expect(saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 0, values())).rejects.toMatchObject({
    code: "forbidden",
  });
  expect(await db.select().from(consultationDrafts)).toHaveLength(0);
});
it("秘密情報・過大入力・不正な値は下書きに保存せず、空欄やモード不一致は送信しない", async () => {
  const b = await seed();
  for (const bad of [
    { ...values(), extra: "x" },
    { ...values(), mode: "take" },
    { ...values(), caseRevision: "-1" },
    values("a".repeat(2001)),
    values("password=secret12345"),
    values("未来", "1"),
  ])
    await expect(saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 0, bad)).rejects.toBeInstanceOf(Error);
  for (const revision of [-1, NaN, 1.5])
    await expect(
      saveConsultationDraft(db, clock, b.opsActor, b.activity.id, revision, values()),
    ).rejects.toBeInstanceOf(Error);
  for (const [v, op] of [
    [values(" "), "resolve"],
    [values(), "reply"],
  ] as const)
    await expect(
      submitConsultationDraft(db, clock, b.opsActor, b.activity.id, {
        revision: 0,
        values: v,
        operation: op,
        requestKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(Error);
  expect(await db.select().from(consultationDrafts)).toHaveLength(0);
  expect(await db.select().from(consultationEvents)).toHaveLength(0);
});
it("下書き消去が失敗したら、回答・状態・操作履歴もまとめてロールバックする", async () => {
  const b = await seed();
  const saved = await saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 0, values());
  await db.execute(
    sql`create function reject_draft_clear() returns trigger language plpgsql as $$ begin if NEW.values is null then raise exception 'fixture: clear failed'; end if; return NEW; end $$`,
  );
  await db.execute(
    sql`create trigger fail_draft_clear before insert or update on consultation_drafts for each row execute function reject_draft_clear()`,
  );
  await expect(
    submitConsultationDraft(db, clock, b.opsActor, b.activity.id, {
      revision: 1,
      values: values(),
      operation: "resolve",
      requestKey: randomUUID(),
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(await loadConsultationDraft(db, b.opsActor, b.activity.id)).toEqual(saved);
  expect(await db.select().from(consultationCases)).toHaveLength(0);
  expect(await db.select().from(consultationEvents)).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});

it("下書きありの一覧は本人分だけを返し、破棄・送信後は一覧から外れる", async () => {
  const b = await seed();
  await saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 0, values());
  const own = await listConsultationCases(db, b.opsActor, { drafts: true, status: "all" });
  expect(own).toMatchObject({ ok: true, value: { total: 1, rows: [{ activityId: b.activity.id, hasDraft: true }] } });
  expect(JSON.stringify(own)).not.toContain("未送信の回答");
  expect(await listConsultationCases(db, b.salesActor, { drafts: true, status: "all" })).toMatchObject({
    ok: true,
    value: { total: 0 },
  });
  await saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 1, null);
  expect(await listConsultationCases(db, b.opsActor, { drafts: true, status: "all" })).toMatchObject({
    ok: true,
    value: { total: 0 },
  });
  await saveConsultationDraft(db, clock, b.opsActor, b.activity.id, 2, values());
  await submitConsultationDraft(db, clock, b.opsActor, b.activity.id, {
    revision: 3,
    values: values(),
    operation: "resolve",
    requestKey: randomUUID(),
  });
  expect(await listConsultationCases(db, b.opsActor, { drafts: true, status: "all" })).toMatchObject({
    ok: true,
    value: { total: 0 },
  });
});
