import { randomUUID } from "node:crypto";
import { claimAssignment, fixedClock } from "@siteoffer/core";
import { type Db, salesActivities, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCompany, createOpsUser, createSalesUser } from "../../../packages/core/src/assignment/test-helpers.ts";
import { ActivityHistoryError, readActivityHistory } from "./activity-history";
import {
  DEFAULT_ACTIVITY_HISTORY,
  normalizeActivityHistoryFilters,
  parseActivityHistoryQuery,
  validActivityHistoryPage,
} from "./activity-history-types";
import { emptyActivity } from "./sales/activity-draft-types";
import { saveActivityDraft } from "./sales/activity-drafts";
import { getMyAssignmentDetail } from "./sales/queries";

let db: Db, close: () => Promise<void>, routeActor: Parameters<typeof readActivityHistory>[1];
const clock = fixedClock("2026-10-19T03:00:00Z");
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/session", () => ({ getCurrentActor: () => routeActor }));
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  routeActor = null;
});
afterEach(async () => {
  await close();
});
async function fixture(count = 55) {
  const me = await createSalesUser(db),
    other = await createSalesUser(db),
    ops = await createOpsUser(db),
    company = await createCompany(db);
  const claim = await claimAssignment(db, clock, me.actor, company.id);
  if (!claim.ok) throw Error(claim.error);
  const assignment = claim.value;
  const rows = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    assignmentId: assignment.id,
    companyId: company.id,
    userId: me.user.id,
    kind: i % 2 ? ("no_answer" as const) : ("negotiating" as const),
    occurredAt: new Date(clock.now().getTime() + Math.floor(i / 2) * 1000),
    note: i === 0 ? "古い合意 100%_確認済み" : null,
    consultOps: i === 0,
  }));
  if (rows.length) await db.insert(salesActivities).values(rows);
  return { me, other, ops, company, assignment, rows };
}
it("55件を全件検索し、同日時でも順序が安定した20件ずつのページを返す", async () => {
  const f = await fixture();
  const expected = [...f.rows]
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id))
    .map((r) => r.id);
  const pages = [];
  for (let page = 1; page <= 3; page++) {
    const result = await readActivityHistory(db, f.me.actor, f.assignment.id, { ...DEFAULT_ACTIVITY_HISTORY, page });
    expect(result.items.length).toBe(page === 3 ? 15 : 20);
    expect(result.total).toBe(55);
    expect(result.pageCount).toBe(3);
    expect(validActivityHistoryPage(result, f.assignment.id)).toBe(true);
    pages.push(...result.items.map((i) => i.id));
  }
  expect(pages).toEqual(expected);
  expect(new Set(pages).size).toBe(55);
  expect(
    (await readActivityHistory(db, f.me.actor, f.assignment.id, { ...DEFAULT_ACTIVITY_HISTORY, page: 999 })).filters
      .page,
  ).toBe(3);
  const first = await readActivityHistory(db, f.me.actor, f.assignment.id);
  expect(first.items.some((i) => i.consultOps)).toBe(false);
  expect(first.hasConsultations).toBe(true);
  expect(first.latestNote).toBe("古い合意 100%_確認済み");
  const detail = await getMyAssignmentDetail(db, f.me.actor, f.assignment.id);
  if (!detail.ok) throw Error(detail.error);
  expect(detail.value.activities).toHaveLength(20);
  expect(detail.value.activityHistory.latestNote).toBe(first.latestNote);
});
it("メモ・活動種別・相談を全履歴から組み合わせ、私用コピーは検索・表示に含めない", async () => {
  const f = await fixture();
  await saveActivityDraft(db, clock, f.me.actor, f.assignment.id, 0, {
    ...emptyActivity(clock.now()),
    note: "PRIVATE-WORKING-COPY",
  });
  const result = await readActivityHistory(db, f.me.actor, f.assignment.id, {
    page: 1,
    query: " 100%_ ",
    kind: "negotiating",
    consultations: "only",
  });
  expect(result.total).toBe(1);
  expect(result.allTotal).toBe(55);
  expect(result.filters.query).toBe("100%_");
  expect(result.items[0]?.id).toBe(f.rows[0]!.id);
  expect(JSON.stringify(result)).not.toContain("PRIVATE-WORKING");
  expect(
    (
      await readActivityHistory(db, f.me.actor, f.assignment.id, {
        ...DEFAULT_ACTIVITY_HISTORY,
        query: "PRIVATE-WORKING-COPY",
      })
    ).total,
  ).toBe(0);
  expect(
    (await readActivityHistory(db, f.me.actor, f.assignment.id, { ...DEFAULT_ACTIVITY_HISTORY, query: "%' OR true--" }))
      .total,
  ).toBe(0);
  expect(
    (
      await readActivityHistory(db, f.me.actor, f.assignment.id, {
        ...DEFAULT_ACTIVITY_HISTORY,
        kind: "no_answer",
        consultations: "only",
      })
    ).total,
  ).toBe(0);
});
it("本人と有効な運営だけが読み、他担当・未ログイン・役割詐称・停止ユーザーを拒否する", async () => {
  const f = await fixture(1);
  expect((await readActivityHistory(db, f.ops.actor, f.assignment.id)).total).toBe(1);
  for (const actor of [null, f.other.actor, { kind: "ops" as const, userId: f.me.user.id }])
    await expect(readActivityHistory(db, actor, f.assignment.id)).rejects.toBeInstanceOf(ActivityHistoryError);
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, f.me.user.id));
  await expect(readActivityHistory(db, f.me.actor, f.assignment.id)).rejects.toMatchObject({ code: "forbidden" });
  await expect(readActivityHistory(db, f.ops.actor, randomUUID())).rejects.toMatchObject({ code: "not_found" });
});
it("不正・重複条件を受け付けず、空の履歴と不正な読み取り応答を区別する", async () => {
  for (const input of [
    { page: "0" },
    { page: ["1", "2"] },
    { q: "bad\n" },
    { q: "x".repeat(201) },
    { kind: "other" },
    { consultations: "unknown" },
  ])
    expect(parseActivityHistoryQuery(input)).toBeNull();
  expect(normalizeActivityHistoryFilters({ ...DEFAULT_ACTIVITY_HISTORY, query: 123 })).toBeNull();
  const f = await fixture(0),
    page = await readActivityHistory(db, f.me.actor, f.assignment.id);
  expect(page).toMatchObject({ items: [], total: 0, pageCount: 1, latestNote: null, hasConsultations: false });
  expect(validActivityHistoryPage(page, randomUUID())).toBe(false);
  expect(validActivityHistoryPage({ ...page, items: [null] }, f.assignment.id)).toBe(false);
  expect(validActivityHistoryPage({ ...page, filters: { ...page.filters, query: 123 } }, f.assignment.id)).toBe(false);
  await expect(
    readActivityHistory(db, f.me.actor, f.assignment.id, { ...DEFAULT_ACTIVITY_HISTORY, page: 0 }),
  ).rejects.toMatchObject({ code: "invalid_input" });
});
it("実際のGETハンドラーが権限・条件・障害を処理し、全応答を非公開・非キャッシュにする", async () => {
  const f = await fixture(22);
  routeActor = f.me.actor;
  const { GET } = await import("@/app/activity-history/[assignmentId]/route");
  const request = (query = "") =>
    GET(new Request(`http://localhost/activity-history/${f.assignment.id}${query}`), {
      params: Promise.resolve({ assignmentId: f.assignment.id }),
    });
  for (const [query, status] of [
    ["", 200],
    ["?page=2", 200],
    ["?page=1&page=2", 400],
    ["?unknown=x", 400],
    ["?q=%0A", 400],
  ] as const) {
    const response = await request(query);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  }
  routeActor = f.other.actor;
  expect((await request()).status).toBe(404);
  routeActor = null;
  expect((await request()).status).toBe(403);
  routeActor = f.me.actor;
  const saved = db;
  db = undefined as unknown as Db;
  try {
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("transaction");
  } finally {
    db = saved;
  }
});
