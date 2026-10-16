import { randomUUID } from "node:crypto";
import {
  assignments,
  auditEvents,
  companies,
  consultationCases,
  consultationEvents,
  type Db,
  salesActivities,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import {
  type ConsultationCommand,
  getConsultationCase,
  listConsultationCases,
  updateConsultationCase,
} from "./consultation.ts";
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
function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
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
      note: "見積もり範囲を確認したい",
      consultOps,
    })
    .returning();
  return { ...b, activity: activity! };
}
function cmd(
  activityId: string,
  operation: ConsultationCommand["operation"],
  revision = 0,
  note = "確認した結果を共有します",
): ConsultationCommand {
  return { activityId, operation, revision, note: operation === "take" ? "" : note, requestKey: randomUUID() };
}

it("既存相談を未対応として読み、担当・回答継続・完了を営業も確認できる", async () => {
  const b = await seed();
  expect(must(await getConsultationCase(db, b.opsActor, b.activity.id))).toMatchObject({
    status: "open",
    revision: 0,
    events: [],
  });
  must(await updateConsultationCase(db, clock, b.opsActor, cmd(b.activity.id, "take")));
  must(await updateConsultationCase(db, clock, b.opsActor, cmd(b.activity.id, "reply", 1, "制作側へ確認しています")));
  must(
    await updateConsultationCase(
      db,
      clock,
      b.opsActor,
      cmd(b.activity.id, "resolve", 2, "追加ページは別途相談と説明してください"),
    ),
  );
  const detail = must(await getConsultationCase(db, b.salesActor, b.activity.id));
  expect(detail).toMatchObject({ status: "resolved", revision: 3, assignedTo: b.ops.id });
  expect(detail.events.map((e) => e.note)).toEqual([
    "",
    "制作側へ確認しています",
    "追加ページは別途相談と説明してください",
  ]);
  expect(JSON.stringify(detail)).not.toContain("payloadHash");
  expect(JSON.stringify(detail)).not.toContain("receiptKey");
  expect(must(await listConsultationCases(db, b.opsActor)).total).toBe(0);
  expect(must(await listConsultationCases(db, b.opsActor, { status: "resolved" })).total).toBe(1);
  expect(await db.select().from(auditEvents)).toHaveLength(3);
});

it("別の運営担当への引き継ぎは明示し、引き継ぐまでは回答できない", async () => {
  const b = await seed();
  const other = await seedUser(db, "ops");
  const actor = { kind: "ops" as const, userId: other.id };
  must(await updateConsultationCase(db, clock, b.opsActor, cmd(b.activity.id, "take")));
  expect(await updateConsultationCase(db, clock, actor, cmd(b.activity.id, "resolve", 1))).toMatchObject({
    ok: false,
    error: "assigned_elsewhere",
  });
  expect(must(await listConsultationCases(db, actor, { mine: true })).total).toBe(0);
  must(await updateConsultationCase(db, clock, actor, cmd(b.activity.id, "take", 1)));
  expect(must(await listConsultationCases(db, actor, { mine: true })).total).toBe(1);
  expect(await updateConsultationCase(db, clock, b.opsActor, cmd(b.activity.id, "reply", 2))).toMatchObject({
    ok: false,
    error: "assigned_elsewhere",
  });
  must(await updateConsultationCase(db, clock, actor, cmd(b.activity.id, "resolve", 2)));
});

it("同じ送信の再試行は一度だけ記録し、その後の追加相談も消さない", async () => {
  const b = await seed();
  const request = cmd(b.activity.id, "resolve");
  const first = must(await updateConsultationCase(db, clock, b.opsActor, request));
  expect(must(await updateConsultationCase(db, clock, b.opsActor, request))).toEqual(first);
  await db.update(assignments).set({ status: "completed" }).where(eq(assignments.id, b.assignment.id));
  must(
    await updateConsultationCase(
      db,
      clock,
      b.salesActor,
      cmd(b.activity.id, "follow_up", 1, "追加で確認したいことがあります"),
    ),
  );
  expect(must(await updateConsultationCase(db, clock, b.opsActor, request))).toEqual({ revision: 2, status: "open" });
  const detail = must(await getConsultationCase(db, b.salesActor, b.activity.id));
  expect(detail.events).toHaveLength(2);
  expect(detail.assignedTo).toBeNull();
  expect(must(await listConsultationCases(db, b.salesActor)).total).toBe(1);
  expect(await updateConsultationCase(db, clock, b.opsActor, { ...request, note: "別の回答" })).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
});

it("同じ版からの同時更新は片方だけ確定し、古い完了操作は上書きしない", async () => {
  const b = await seed();
  const other = await seedUser(db, "ops");
  const results = await Promise.all(
    [b.opsActor, { kind: "ops" as const, userId: other.id }].map((a) =>
      updateConsultationCase(db, clock, a, cmd(b.activity.id, "take")),
    ),
  );
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)).toMatchObject({ error: "conflict" });
  expect(await updateConsultationCase(db, clock, b.opsActor, cmd(b.activity.id, "resolve"))).toMatchObject({
    ok: false,
    error: "conflict",
  });
  expect(await db.select().from(consultationEvents)).toHaveLength(1);
});

it("完了後は再開理由を記録し、回答済みの履歴を上書きしない", async () => {
  const b = await seed();
  must(await updateConsultationCase(db, clock, b.opsActor, cmd(b.activity.id, "resolve")));
  expect(await updateConsultationCase(db, clock, b.opsActor, cmd(b.activity.id, "reply", 1))).toMatchObject({
    ok: false,
    error: "invalid_state",
  });
  must(
    await updateConsultationCase(
      db,
      clock,
      b.opsActor,
      cmd(b.activity.id, "reopen", 1, "回答内容を追加で確認するため"),
    ),
  );
  expect(must(await getConsultationCase(db, b.opsActor, b.activity.id))).toMatchObject({
    status: "open",
    revision: 2,
    assignedTo: null,
  });
  expect(await updateConsultationCase(db, clock, b.opsActor, cmd(b.activity.id, "reopen", 2))).toMatchObject({
    ok: false,
    error: "invalid_state",
  });
  expect(await db.select().from(consultationEvents)).toHaveLength(2);
});

it("営業の他担当・権限のない操作・利用停止を拒否し、メモを漏らさない", async () => {
  const b = await seed();
  expect(await getConsultationCase(db, b.otherSalesActor, b.activity.id)).toMatchObject({
    ok: false,
    error: "not_found",
  });
  expect(
    must(await listConsultationCases(db, b.otherSalesActor, { status: "all", assignmentId: b.assignment.id })).total,
  ).toBe(0);
  expect(await updateConsultationCase(db, clock, b.otherSalesActor, cmd(b.activity.id, "follow_up"))).toMatchObject({
    ok: false,
    error: "not_found",
  });
  expect(await updateConsultationCase(db, clock, b.salesActor, cmd(b.activity.id, "resolve"))).toMatchObject({
    ok: false,
    error: "forbidden",
  });
  expect(await getConsultationCase(db, null, b.activity.id)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await listConsultationCases(db, { kind: "system", job: "test" })).toMatchObject({
    ok: false,
    error: "forbidden",
  });
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, b.ops.id));
  expect(await getConsultationCase(db, b.opsActor, b.activity.id)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await updateConsultationCase(db, clock, b.opsActor, cmd(b.activity.id, "take"))).toMatchObject({
    ok: false,
    error: "forbidden",
  });
  expect(await db.select().from(consultationEvents)).toHaveLength(0);
});

it("通常の活動は相談として読まず、空欄・上限・秘密情報を記録しない", async () => {
  const normal = await seed(false);
  expect(await getConsultationCase(db, normal.opsActor, normal.activity.id)).toMatchObject({
    ok: false,
    error: "not_found",
  });
  expect(await updateConsultationCase(db, clock, normal.opsActor, cmd(normal.activity.id, "take"))).toMatchObject({
    ok: false,
    error: "not_found",
  });
  const b = await seed();
  for (const note of ["   ", "長".repeat(2001), "password=secret12345"])
    expect(await updateConsultationCase(db, clock, b.opsActor, cmd(b.activity.id, "resolve", 0, note))).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  expect(
    await updateConsultationCase(db, clock, b.opsActor, { ...cmd(b.activity.id, "take"), requestKey: "bad" }),
  ).toMatchObject({ ok: false, error: "invalid_input" });
  expect(await updateConsultationCase(db, clock, b.opsActor, cmd(b.activity.id, "take", -1))).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
  expect(await db.select().from(consultationCases)).toHaveLength(0);
  expect(await db.select().from(consultationEvents)).toHaveLength(0);
});

it("大量の相談を30件ずつ辿れ、企業名の記号はワイルドカードにしない", async () => {
  const b = await seed();
  await db.update(companies).set({ name: "架空_100%相談" }).where(eq(companies.id, b.company.id));
  await db.insert(salesActivities).values(
    Array.from({ length: 64 }, (_, i) => ({
      assignmentId: b.assignment.id,
      companyId: b.company.id,
      userId: b.sales.id,
      kind: "negotiating" as const,
      occurredAt: clock.now(),
      consultOps: true,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
    })),
  );
  const first = must(await listConsultationCases(db, b.opsActor, { q: "_100%" }));
  expect(first.total).toBe(65);
  expect(first.pages).toBe(3);
  expect(first.rows).toHaveLength(30);
  const second = must(await listConsultationCases(db, b.opsActor, { page: 2 }));
  const last = must(await listConsultationCases(db, b.opsActor, { page: 999 }));
  expect(second.rows).toHaveLength(30);
  expect(last.rows).toHaveLength(5);
  expect(last.page).toBe(3);
  expect(new Set([...first.rows, ...second.rows, ...last.rows].map((r) => r.activityId)).size).toBe(65);
  expect(must(await listConsultationCases(db, b.opsActor, { q: "%missing" })).total).toBe(0);
});

it("営業の全件一覧は新しい回答を先に表示し、過去の相談に埋もれさせない", async () => {
  const b = await seed();
  await db
    .update(salesActivities)
    .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
    .where(eq(salesActivities.id, b.activity.id));
  await db
    .insert(salesActivities)
    .values({
      assignmentId: b.assignment.id,
      companyId: b.company.id,
      userId: b.sales.id,
      kind: "negotiating",
      occurredAt: clock.now(),
      consultOps: true,
      createdAt: new Date("2026-10-01T00:00:00Z"),
    });
  must(await updateConsultationCase(db, clock, b.opsActor, cmd(b.activity.id, "resolve")));
  const list = must(await listConsultationCases(db, b.salesActor, { status: "all" }));
  expect(list.rows[0]?.activityId).toBe(b.activity.id);
  expect(list.rows[0]?.status).toBe("resolved");
});
