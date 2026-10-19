import { randomUUID } from "node:crypto";
import { companies, type Db, siteAudits, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getCompanyAuditHistory } from "./audit-history";
import { seedAuditHistoryFixture } from "./audit-history.test-fixture";

const query = { status: "all", sort: "newest", page: 1 } as const;
let db: Db, close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
function value<T>(result: { ok: true; value: T } | { ok: false; error: string }) {
  if (!result.ok) throw Error(result.error);
  return result.value;
}

it("全240件を同日時の境界でも重複・欠落なく読み、全状態と古い順を選べる", async () => {
  const s = await seedAuditHistoryFixture(db),
    ids: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = value(await getCompanyAuditHistory(db, s.ops, s.company.id, { ...query, page }));
    expect(data.total).toBe(240);
    expect(data.pages).toBe(10);
    expect(data.items).toHaveLength(page === 10 ? 15 : 25);
    ids.push(...data.items.map((item) => item.id));
  }
  expect(new Set(ids)).toEqual(new Set(s.records.map((item) => item.id)));
  expect(ids).toHaveLength(240);
  const oldest = value(await getCompanyAuditHistory(db, s.ops, s.company.id, { ...query, sort: "oldest" }));
  expect(oldest.items[0]!.id).toBe(ids.at(-1));
  for (const status of ["queued", "collecting", "scoring", "evaluated", "unevaluable", "failed"] as const) {
    const data = value(await getCompanyAuditHistory(db, s.ops, s.company.id, { ...query, status }));
    expect(data.total).toBe(40);
    expect(data.allTotal).toBe(240);
    expect(data.items.every((item) => item.status === status)).toBe(true);
  }
  const clamped = value(await getCompanyAuditHistory(db, s.ops, s.company.id, { ...query, page: 2147483647 }));
  expect(clamped.page).toBe(10);
});
it("200件より古い指定の診断と根拠を開き、別企業の番号は推測して表示しない", async () => {
  const s = await seedAuditHistoryFixture(db),
    old = s.records[3]!;
  const data = value(await getCompanyAuditHistory(db, s.ops, s.company.id, { ...query, audit: old.id.toUpperCase() }));
  expect(data.selected?.id).toBe(old.id);
  expect(data.selected?.targetUrl).toBe(s.site.url);
  expect(JSON.stringify(data)).not.toContain("private-path-never-render");
  expect(JSON.stringify(data)).not.toContain("generationJobId");
  expect(await getCompanyAuditHistory(db, s.ops, s.company.id, { ...query, audit: s.otherAudit.id })).toMatchObject({
    ok: false,
    error: "not_found",
  });
  expect(await getCompanyAuditHistory(db, s.ops, s.company.id, { ...query, audit: randomUUID() })).toMatchObject({
    ok: false,
    error: "not_found",
  });
});
it("同じ対象の直前の完了診断と根拠を比較し、点差を正確に保持する", async () => {
  const s = await seedAuditHistoryFixture(db),
    data = value(await getCompanyAuditHistory(db, s.ops, s.company.id, { ...query, audit: s.selected.id }));
  expect(data.previous?.id).toBe(s.previous.id);
  expect(data.comparison).toMatchObject({ comparable: true, scoreDelta: "0.1" });
  expect(data.selectedFindings).toHaveLength(2);
  expect(data.selectedFindings.find((item) => item.itemCode === "A1")?.observations).toEqual([
    { url: s.site.url, evidence: "試験専用の根拠" },
  ]);
  expect(data.comparison?.changes.map((item) => item.itemCode)).toEqual(["A1", "D1"]);
  expect(data.comparison?.changes[1]?.after).toMatchObject({ status: "unevaluable", score: null });
  expect(data.comparison?.changes[0]?.before).not.toHaveProperty("observations");
});
it("異なるURL・サイトID・他企業の完了結果を前回として採用しない", async () => {
  const s = await seedAuditHistoryFixture(db);
  await db
    .update(siteAudits)
    .set({ targetUrl: "https://changed.example.test/" })
    .where(eq(siteAudits.id, s.previous.id));
  await db.update(siteAudits).set({ websiteId: s.otherSite.id }).where(eq(siteAudits.id, s.records[225]!.id));
  const data = value(await getCompanyAuditHistory(db, s.ops, s.company.id, { ...query, audit: s.selected.id }));
  expect(data.previous?.id).toBe(s.records[219]!.id);
});
it("空の履歴・該当なし・絞り込み外の選択を区別する", async () => {
  const s = await seedAuditHistoryFixture(db);
  const [empty] = await db.insert(companies).values({ name: "履歴なし" }).returning();
  const noRows = value(await getCompanyAuditHistory(db, s.ops, empty!.id, query));
  expect(noRows).toMatchObject({ total: 0, allTotal: 0, page: 1, pages: 1, selected: null });
  expect(value(await getCompanyAuditHistory(db, s.ops, s.other.id, { ...query, status: "failed" }))).toMatchObject({
    total: 0,
    allTotal: 1,
    selected: null,
  });
  expect(
    value(await getCompanyAuditHistory(db, s.ops, s.company.id, { ...query, status: "failed", audit: s.selected.id })),
  ).toMatchObject({ selectedOutsideFilter: true, selected: { id: s.selected.id } });
});
it("運営以外・利用停止・役割の偽装・不正な入力を拒否する", async () => {
  const s = await seedAuditHistoryFixture(db),
    untouched = new Proxy({} as Db, {
      get() {
        throw Error("DB touched");
      },
    });
  for (const actor of [null, s.sales, { kind: "system" as const, job: "fixture" }])
    expect(await getCompanyAuditHistory(untouched, actor, s.company.id, query)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  for (const actor of [
    { kind: "ops" as const, userId: s.sales.userId },
    { kind: "ops" as const, userId: randomUUID() },
  ])
    expect(await getCompanyAuditHistory(db, actor, s.company.id, query)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  expect(await getCompanyAuditHistory(db, s.ops, "bad", query)).toMatchObject({ ok: false, error: "not_found" });
  expect(await getCompanyAuditHistory(db, s.ops, randomUUID(), query)).toMatchObject({ ok: false, error: "not_found" });
  expect(await getCompanyAuditHistory(db, s.ops, s.company.id, { ...query, page: 0 })).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
  expect(await getCompanyAuditHistory(db, s.ops, s.company.id, null as never)).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  expect(await getCompanyAuditHistory(db, s.ops, s.company.id, query)).toMatchObject({ ok: false, error: "forbidden" });
});
