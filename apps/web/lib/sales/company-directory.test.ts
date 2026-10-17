import { randomUUID } from "node:crypto";
import { assignments, companies, contracts, type Db, siteAudits, users, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedUser } from "../ops/test-seed";
import type { CompanyListFilter } from "./directory-query";
import { getCompanyDetail, listSellableCompanies } from "./queries";

let db: Db, close: () => Promise<void>, me: Awaited<ReturnType<typeof seedUser>>, other: typeof me;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  me = await seedUser(db, "sales");
  other = await seedUser(db, "sales");
});
afterEach(async () => {
  await close();
});
async function seed(n: number) {
  return db
    .insert(companies)
    .values(
      Array.from({ length: n }, (_, i) => ({
        name: `候補${String(i).padStart(4, "0")}`,
        pipelineStatus: "sellable" as const,
        prefecture: "愛知県",
        city: "名古屋市",
        industry: "設計",
        address: "一覧には不要な住所",
        representativePhone: "000-0000-0000",
      })),
    )
    .returning();
}
async function directory(filter: CompanyListFilter = {}) {
  const r = await listSellableCompanies(db, me.actor, filter);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe("営業候補全体の検索とページ", () => {
  it("200社より後を検索でき、件数・最終ページ・概要を正しく返す", async () => {
    const rows = await seed(251),
      first = await directory();
    expect(first).toMatchObject({
      total: 251,
      pageSize: 20,
      pageCount: 13,
      counts: { all: 251, none: 251, mine: 0, other: 0 },
    });
    expect(first.items).toHaveLength(20);
    expect(first.items.map((c) => c.id)).toEqual(rows.slice(0, 20).map((c) => c.id));
    const last = await directory({ page: 13 });
    expect(last.items.map((c) => c.id)).toEqual(rows.slice(240).map((c) => c.id));
    expect((await directory({ page: Number.MAX_SAFE_INTEGER })).filters.page).toBe(13);
    expect((await directory({ query: "候補0250" })).items.map((c) => c.id)).toEqual([rows[250]!.id]);
    expect(JSON.stringify(first)).not.toContain("一覧には不要な住所");
    expect(JSON.stringify(first)).not.toContain("000-0000-0000");
  });

  it("担当の検索・件数をページより前に適用し、他人の担当ID・利用者IDを返さない", async () => {
    const rows = await seed(45);
    const claimed = await db
      .insert(assignments)
      .values(
        rows.slice(0, 25).map((c, i) => ({
          companyId: c.id,
          userId: i < 3 ? me.user.id : other.user.id,
          claimedAt: new Date(),
        })),
      )
      .returning();
    await db
      .insert(assignments)
      .values({ companyId: rows[25]!.id, userId: other.user.id, claimedAt: new Date(), status: "released" });
    expect((await directory()).counts).toEqual({ all: 45, none: 20, mine: 3, other: 22 });
    const mine = await directory({ assignment: "mine" });
    expect(mine.items.map((c) => c.myAssignmentId)).toEqual(claimed.slice(0, 3).map((a) => a.id));
    const theirs = await directory({ assignment: "other", page: 2 });
    expect(theirs).toMatchObject({ total: 22, pageCount: 2 });
    expect(theirs.items).toHaveLength(2);
    expect(theirs.items.every((c) => c.assignment === "other" && c.myAssignmentId === null)).toBe(true);
    expect(JSON.stringify(theirs)).not.toContain(other.user.id);
    for (const a of claimed.slice(3)) expect(JSON.stringify(theirs)).not.toContain(a.id);
    const empty = await directory({ query: "存在しない会社", assignment: "mine", page: 100 });
    expect(empty).toMatchObject({ total: 0, pageCount: 1, filters: { page: 1 }, items: [] });
  });

  it("契約確認中・完了の企業を件数・一覧・選択肢のすべてから除く", async () => {
    const rows = await seed(2);
    await db
      .update(companies)
      .set({ city: "契約済み限定市", industry: "契約済み限定業" })
      .where(eq(companies.id, rows[0]!.id));
    const [a] = await db
      .insert(assignments)
      .values({ companyId: rows[0]!.id, userId: other.user.id, claimedAt: new Date() })
      .returning();
    const [ct] = await db
      .insert(contracts)
      .values({
        companyId: rows[0]!.id,
        assignmentId: a!.id,
        salesUserId: other.user.id,
        status: "reported",
        reportedAt: new Date(),
      })
      .returning();
    for (const status of ["reported", "under_review", "completed"] as const) {
      await db.update(contracts).set({ status }).where(eq(contracts.id, ct!.id));
      const result = await directory();
      expect(result.total).toBe(1);
      expect(result.counts.other).toBe(0);
      expect(result.items[0]?.id).toBe(rows[1]!.id);
      expect(result.options.cities.some((c) => c.city === "契約済み限定市")).toBe(false);
      expect(result.options.industries).not.toContain("契約済み限定業");
    }
    await db.update(contracts).set({ status: "rejected" }).where(eq(contracts.id, ct!.id));
    expect((await directory()).total).toBe(2);
  });

  it("地域・業種を組み合わせ、検索中のSQL記号を通常文字として照合する", async () => {
    const rows = await seed(4);
    await db.update(companies).set({ name: "100%_設計\\LAB", industry: "建築" }).where(eq(companies.id, rows[0]!.id));
    await db.update(companies).set({ city: "豊田市" }).where(eq(companies.id, rows[1]!.id));
    await db.update(companies).set({ prefecture: "岐阜県", city: "岐阜市" }).where(eq(companies.id, rows[2]!.id));
    await db
      .update(companies)
      .set({ pipelineStatus: "in_review", industry: "非公開業種" })
      .where(eq(companies.id, rows[3]!.id));
    for (const query of ["%", "_", "\\", "lab"])
      expect((await directory({ query })).items.map((c) => c.id)).toEqual([rows[0]!.id]);
    expect((await directory({ query: "名古屋", prefecture: "愛知県", industry: "建築" })).total).toBe(1);
    expect((await directory({ city: "豊田市", prefecture: "岐阜県" })).total).toBe(0);
    expect((await directory({ query: "%' OR true --" })).total).toBe(0);
    expect((await directory()).options.industries).not.toContain("非公開業種");
  });

  it("同名・同評価の会社もIDで安定し、同時刻の最新診断と主サイトを決める", async () => {
    const rows = await seed(25);
    await db.update(companies).set({ name: "同じ会社名" });
    const expected = rows.map((c) => c.id).sort();
    expect((await directory()).items.map((c) => c.id)).toEqual(expected.slice(0, 20));
    expect((await directory({ page: 2 })).items.map((c) => c.id)).toEqual(expected.slice(20));
    const c = rows[0]!,
      when = new Date("2026-10-17T00:00:00Z");
    const sites = await db
      .insert(websites)
      .values(
        [false, true].map((isPrimary, i) => ({
          companyId: c.id,
          url: `https://site-${i}.example.test`,
          normalizedUrl: `https://site-${i}.example.test`,
          domain: "example.test",
          isPrimary,
          createdAt: when,
        })),
      )
      .returning();
    await db.insert(siteAudits).values(
      ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"].map((id, i) => ({
        id,
        companyId: c.id,
        websiteId: sites[0]!.id,
        targetUrl: sites[0]!.url,
        status: "evaluated" as const,
        totalScore: i ? "90" : "10",
        createdAt: when,
      })),
    );
    const result = await directory();
    expect(result.items[0]).toMatchObject({ id: c.id, totalScore: "90", siteUrl: sites[1]!.url });
    const detail = await getCompanyDetail(db, me.actor, c.id);
    expect(detail.ok && detail.value.audit?.totalScore).toBe("90");
    expect((await directory({ sort: "score_desc" })).items[0]?.id).toBe(c.id);
  });

  it("無効・役割違い・失効したアカウントと不正な条件を拒否する", async () => {
    await seed(1);
    for (const actor of [
      null,
      { kind: "system", job: "test" },
      { kind: "customer_user", userId: me.user.id },
      { kind: "sales", userId: randomUUID() },
      { kind: "ops", userId: me.user.id },
    ] as const)
      expect((await listSellableCompanies(db, actor)).ok).toBe(false);
    for (const filter of [
      { page: 0 },
      { page: 1.1 },
      { page: Infinity },
      { sort: "wrong" },
      { assignment: "__proto__" },
      { query: "a".repeat(121) },
      { city: "a\n" },
    ])
      expect(await listSellableCompanies(db, me.actor, filter as CompanyListFilter)).toMatchObject({
        ok: false,
        error: "invalid_input",
      });
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, me.user.id));
    expect(await listSellableCompanies(db, me.actor)).toMatchObject({ ok: false, error: "forbidden" });
  });
});
