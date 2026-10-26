import { randomUUID } from "node:crypto";
import { companies, contentAccess, contentEntries, contentRevisions, contracts, type Db, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  listContentManagementCompanies,
  listManagedArticles,
  type ManagedArticleFilters,
} from "./content-management.ts";
import { seedDeliveryBase } from "./delivery/test-helpers.ts";

let db: Db, close: () => Promise<void>;
const filters: ManagedArticleFilters = { page: 1, query: "", category: "all", publication: "all" };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
async function setup() {
  const b = await seedDeliveryBase(db);
  const [u] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.test`,
      displayName: "記事検索の顧客",
      role: "customer",
      passwordHash: "fixture",
    })
    .returning();
  const [access] = await db
    .insert(contentAccess)
    .values({
      companyId: b.company.id,
      contractId: b.contract.id,
      email: u!.email,
      userId: u!.id,
      status: "active",
      tokenHash: randomUUID(),
      expiresAt: new Date(),
      requestId: randomUUID(),
      createdBy: b.ops.userId,
      updatedAt: new Date(),
    })
    .returning();
  return { ...b, customer: { kind: "customer_user" as const, userId: u!.id }, access: access! };
}
async function seed(s: Awaited<ReturnType<typeof setup>>, count = 1) {
  const entries = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    companyId: s.company.id,
    slug: `item-${i + 1}`,
    currentRevision: 1,
    updatedAt: new Date(Date.UTC(2026, 9, 17) - i * 86400000),
  }));
  await db.insert(contentEntries).values(entries);
  await db.insert(contentRevisions).values(
    entries.map((e, i) => ({
      entryId: e.id,
      revision: 1,
      title: `記事 ${i + 1}`,
      body: "本文".repeat(15000),
      category: i % 2 ? "blog" : "news",
      createdBy: s.ops.userId,
    })),
  );
  return entries;
}
it("501件を20件ずつ最後まで辿り、本文と写真データを一覧へ転送しない", async () => {
  const s = await setup(),
    entries = await seed(s, 501);
  const first = await listManagedArticles(db, s.customer, s.company.id, filters);
  expect(first.total).toBe(501);
  expect(first.pageCount).toBe(26);
  expect(first.items).toHaveLength(20);
  expect(first.items[0]?.id).toBe(entries[0]!.id);
  expect(first.items[0]).not.toHaveProperty("body");
  expect(first.items[0]).not.toHaveProperty("images");
  expect(JSON.stringify(first).length).toBeLessThan(20000);
  const last = await listManagedArticles(db, s.customer, s.company.id, { ...filters, page: 26 });
  expect(last.items.map((i) => i.id)).toEqual([entries[500]!.id]);
  const clamped = await listManagedArticles(db, s.ops, s.company.id, { ...filters, page: Number.MAX_SAFE_INTEGER });
  expect(clamped.filters.page).toBe(26);
  expect(clamped.items.map((i) => i.id)).toEqual([entries[500]!.id]);
});
it("下書きと現在の掲載版を検索し、歴史上の未掲載本文と他社は検索しない", async () => {
  const s = await setup(),
    foreign = await setup(),
    entries = await seed(s, 2);
  await seed(foreign);
  await db
    .update(contentEntries)
    .set({ currentRevision: 3, publishedRevision: 1, publicationRevision: 1 })
    .where(eq(contentEntries.id, entries[0]!.id));
  await db
    .update(contentRevisions)
    .set({ title: "掲載中の旧見出し", body: "掲載中だけの検索語" })
    .where(eq(contentRevisions.entryId, entries[0]!.id));
  await db.insert(contentRevisions).values([
    {
      entryId: entries[0]!.id,
      revision: 2,
      title: "過去の未掲載",
      body: "履歴だけの単語",
      category: "news",
      createdBy: s.ops.userId,
    },
    {
      entryId: entries[0]!.id,
      revision: 3,
      title: "新しい下書き",
      body: "下書きだけの単語",
      category: "blog",
      createdBy: s.ops.userId,
    },
  ]);
  const published = await listManagedArticles(db, s.customer, s.company.id, { ...filters, query: "掲載中だけ" });
  expect(published.total).toBe(1);
  expect(published.items[0]).toMatchObject({ title: "新しい下書き", publishedTitle: "掲載中の旧見出し" });
  expect((await listManagedArticles(db, s.customer, s.company.id, { ...filters, query: "下書きだけ" })).total).toBe(1);
  expect((await listManagedArticles(db, s.customer, s.company.id, { ...filters, query: "履歴だけ" })).total).toBe(0);
  expect((await listManagedArticles(db, s.customer, s.company.id, filters)).total).toBe(2);
});
it("掲載中・未掲載・掲載停止・未反映の変更と現在の種類を組み合わせて絞り込む", async () => {
  const s = await setup(),
    entries = await seed(s, 4);
  await db
    .update(contentEntries)
    .set({ publishedRevision: 1, publicationRevision: 1 })
    .where(eq(contentEntries.id, entries[1]!.id));
  await db
    .update(contentEntries)
    .set({ currentRevision: 2, publishedRevision: 1, publicationRevision: 1 })
    .where(eq(contentEntries.id, entries[2]!.id));
  await db.insert(contentRevisions).values({
    entryId: entries[2]!.id,
    revision: 2,
    title: "更新待ち",
    body: "更新本文",
    category: "blog",
    createdBy: s.ops.userId,
  });
  await db.update(contentEntries).set({ publicationRevision: 2 }).where(eq(contentEntries.id, entries[3]!.id));
  const read = (publication: ManagedArticleFilters["publication"]) =>
    listManagedArticles(db, s.ops, s.company.id, { ...filters, publication });
  expect((await read("published")).total).toBe(2);
  expect((await read("unpublished")).items.map((i) => i.id)).toEqual([entries[0]!.id, entries[3]!.id]);
  expect((await read("changes")).items.map((i) => i.id)).toEqual([entries[2]!.id]);
  expect(
    (
      await listManagedArticles(db, s.ops, s.company.id, { ...filters, category: "blog", publication: "changes" })
    ).items.map((i) => i.id),
  ).toEqual([entries[2]!.id]);
});
it("SQL記号を通常の文字として扱い、本文の奥・URL名・元URLを探せる", async () => {
  const s = await setup(),
    entries = await seed(s, 2);
  await db
    .update(contentRevisions)
    .set({ body: `${"本文".repeat(1000)} 100% _ \\ 日本語🌸` })
    .where(eq(contentRevisions.entryId, entries[1]!.id));
  await db
    .update(contentEntries)
    .set({ sourceUrl: "https://example.test/old-news/spring" })
    .where(eq(contentEntries.id, entries[0]!.id));
  for (const query of ["100%", "_", "\\", "日本語🌸"])
    expect((await listManagedArticles(db, s.ops, s.company.id, { ...filters, query })).items.map((i) => i.id)).toEqual([
      entries[1]!.id,
    ]);
  expect(
    (await listManagedArticles(db, s.ops, s.company.id, { ...filters, query: "item-1" })).items.map((i) => i.id),
  ).toEqual([entries[0]!.id]);
  expect(
    (await listManagedArticles(db, s.ops, s.company.id, { ...filters, query: "old-news/spring" })).items.map(
      (i) => i.id,
    ),
  ).toEqual([entries[0]!.id]);
});
it("同時刻はID、同一ミリ秒内はDBの精度で並べ、ページをまたいで重複させない", async () => {
  const s = await setup(),
    entries = await seed(s, 23);
  await db.update(contentEntries).set({ updatedAt: new Date("2026-10-17T00:00:00Z") });
  const ordered = entries
    .map((e) => e.id)
    .sort()
    .reverse();
  const a = await listManagedArticles(db, s.ops, s.company.id, filters),
    b = await listManagedArticles(db, s.ops, s.company.id, { ...filters, page: 2 });
  expect([...a.items, ...b.items].map((i) => i.id)).toEqual(ordered);
  await db
    .update(contentEntries)
    .set({ updatedAt: sql`'2026-10-17T00:00:00.000001Z'::timestamptz` })
    .where(eq(contentEntries.id, ordered[0]!));
  await db
    .update(contentEntries)
    .set({ updatedAt: sql`'2026-10-17T00:00:00.000002Z'::timestamptz` })
    .where(eq(contentEntries.id, ordered[1]!));
  expect((await listManagedArticles(db, s.ops, s.company.id, filters)).items[0]?.id).toBe(ordered[1]);
});
it("300社より前の会社も全件検索でき、会社名と地域を通常の文字で検索する", async () => {
  const s = await setup();
  const rows = await db
    .insert(companies)
    .values(
      Array.from({ length: 302 }, (_, i) => ({
        name: i === 0 ? "古い 100% _ 会社" : `検証会社${i}`,
        prefecture: "愛知県",
        city: i === 0 ? "名古屋市" : "豊田市",
        updatedAt: new Date(Date.UTC(2026, 9, 17) - i * 86400000),
      })),
    )
    .returning();
  expect((await listContentManagementCompanies(db, s.ops, { query: "", page: 1 })).items).toHaveLength(20);
  expect((await listContentManagementCompanies(db, s.ops, { query: "検証会社", page: 16 })).items.length).toBe(1);
  for (const query of ["100%", "_", "名古屋市"])
    expect((await listContentManagementCompanies(db, s.ops, { query, page: 1 })).items.map((i) => i.id)).toEqual([
      rows[0]!.id,
    ]);
  const last = await listContentManagementCompanies(db, s.ops, { query: "", page: Number.MAX_SAFE_INTEGER });
  expect(last.total).toBe(303);
  expect(last.filters.page).toBe(16);
});
it("顧客は完了契約の有効な会社だけを検索でき、失効後の一覧・他社への直接指定を拒否する", async () => {
  const s = await setup(),
    foreign = await setup();
  await seed(s);
  await seed(foreign);
  expect((await listContentManagementCompanies(db, s.customer, { query: "", page: 1 })).items.map((i) => i.id)).toEqual(
    [s.company.id],
  );
  await expect(listManagedArticles(db, s.customer, foreign.company.id, filters)).rejects.toThrow("利用できません");
  await db.update(contentAccess).set({ status: "revoked" }).where(eq(contentAccess.id, s.access.id));
  expect((await listContentManagementCompanies(db, s.customer, { query: "", page: 1 })).total).toBe(0);
  await expect(listManagedArticles(db, s.customer, s.company.id, filters)).rejects.toThrow("利用できません");
  await db.update(contentAccess).set({ status: "active" }).where(eq(contentAccess.id, s.access.id));
  await db.update(contracts).set({ status: "reported" }).where(eq(contracts.id, s.contract.id));
  expect((await listContentManagementCompanies(db, s.customer, { query: "", page: 1 })).total).toBe(0);
  await expect(listManagedArticles(db, s.customer, s.company.id, filters)).rejects.toThrow("利用契約");
});
it("匿名・営業・停止した運営と顧客には記事も会社一覧も返さない", async () => {
  const s = await setup();
  for (const actor of [null, s.sales]) {
    await expect(listManagedArticles(db, actor, s.company.id, filters)).rejects.toThrow();
    await expect(listContentManagementCompanies(db, actor, { query: "", page: 1 })).rejects.toThrow();
  }
  for (const actor of [s.ops, s.customer]) {
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, actor.userId));
    await expect(listManagedArticles(db, actor, s.company.id, filters)).rejects.toThrow();
    await expect(listContentManagementCompanies(db, actor, { query: "", page: 1 })).rejects.toThrow();
  }
});
it("空の一覧は1ページへ戻し、不正・過長・制御文字の条件をDBへ流さない", async () => {
  const s = await setup();
  expect(await listManagedArticles(db, s.ops, s.company.id, { ...filters, page: 999 })).toMatchObject({
    items: [],
    total: 0,
    pageCount: 1,
    filters: { page: 1 },
  });
  for (const patch of [
    { page: 0 },
    { page: 1.5 },
    { query: "a".repeat(121) },
    { query: "a\nb" },
    { category: "other" },
    { publication: "other" },
  ])
    await expect(
      listManagedArticles(db, s.ops, s.company.id, { ...filters, ...patch } as ManagedArticleFilters),
    ).rejects.toThrow();
  for (const f of [
    { page: 0, query: "" },
    { page: 1, query: "\0" },
  ])
    await expect(listContentManagementCompanies(db, s.ops, f)).rejects.toThrow();
});
