import { randomUUID } from "node:crypto";
import { companies, contentEntries, contentRevisions, type Db, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { publishedArticles } from "./content.ts";
import { findPublishedArticle, listPublishedArticles } from "./content-published.ts";

let db: Db, close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
const filters = { page: 1, query: "", category: "all" as const };
async function setup(count = 1) {
  const [u] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test`, passwordHash: "fixture", displayName: "架空運営", role: "ops" })
    .returning();
  const [c] = await db.insert(companies).values({ name: "架空企業" }).returning();
  const entries = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    companyId: c!.id,
    slug: `article-${i + 1}`,
    currentRevision: 1,
    publishedRevision: 1,
    publicationRevision: 1,
    publishedAt: new Date(Date.UTC(2026, 9, 17) - i * 86400000),
    updatedAt: new Date(),
  }));
  await db.insert(contentEntries).values(entries);
  await db.insert(contentRevisions).values(
    entries.map((e, i) => ({
      entryId: e.id,
      revision: 1,
      title: `掲載記事 ${i + 1}`,
      body: `公開済みの本文 ${i + 1}`,
      category: i % 2 ? "blog" : "news",
      createdBy: u!.id,
    })),
  );
  return { companyId: c!.id, userId: u!.id, entries };
}
it("501件を打ち切らず、本文を全件読まずに20件ずつ最後の記事まで到達できる", async () => {
  const s = await setup(501),
    first = await listPublishedArticles(db, s.companyId, filters);
  expect(first.total).toBe(501);
  expect(first.pageCount).toBe(26);
  expect(first.items).toHaveLength(20);
  expect(first.items[0]!.slug).toBe("article-1");
  expect(first.items[0]).not.toHaveProperty("body");
  const last = await listPublishedArticles(db, s.companyId, { ...filters, page: 26 });
  expect(last.items.map((a) => a.slug)).toEqual(["article-501"]);
  expect(last.total).toBe(501);
  const all = await Promise.all(
    Array.from({ length: 26 }, (_, i) => listPublishedArticles(db, s.companyId, { ...filters, page: i + 1 })),
  );
  expect(new Set(all.flatMap((p) => p.items.map((a) => a.id))).size).toBe(501);
  expect(await publishedArticles(db, s.companyId)).toHaveLength(501);
  const article = await findPublishedArticle(db, s.companyId, "article-501");
  expect(article?.body).toBe("公開済みの本文 501");
  expect((await listPublishedArticles(db, s.companyId, { ...filters, page: 27 })).items).toEqual([]);
});
it("検索・種類・単独URLは掲載版だけを使い、下書き・掲載停止・他社の記事を出さない", async () => {
  const s = await setup(3),
    foreign = await setup();
  await db.insert(contentRevisions).values({
    entryId: s.entries[0]!.id,
    revision: 2,
    title: "非公開の見出し",
    body: "下書きにだけある言葉",
    category: "blog",
    createdBy: s.userId,
  });
  await db.update(contentEntries).set({ currentRevision: 2 }).where(eq(contentEntries.id, s.entries[0]!.id));
  await db.update(contentEntries).set({ publishedRevision: null }).where(eq(contentEntries.id, s.entries[2]!.id));
  expect((await listPublishedArticles(db, s.companyId, { ...filters, query: "下書きにだけ" })).total).toBe(0);
  expect(
    (await listPublishedArticles(db, s.companyId, { ...filters, category: "news", query: "本文" })).items.map(
      (a) => a.slug,
    ),
  ).toEqual(["article-1"]);
  expect((await findPublishedArticle(db, s.companyId, "article-1"))?.revision).toBe(1);
  expect(await findPublishedArticle(db, s.companyId, "article-3")).toBeNull();
  expect((await findPublishedArticle(db, foreign.companyId, "article-1"))?.id).toBe(foreign.entries[0]!.id);
  expect(await findPublishedArticle(db, foreign.companyId, "article-2")).toBeNull();
});
it("SQLの記号を検索文字として扱い、日本語・本文の奥も探せる。元の掲載日を優先する", async () => {
  const s = await setup(2);
  await db
    .update(contentRevisions)
    .set({ body: `先頭${"あ".repeat(400)} 100% _ \\ ' 日本語🌸` })
    .where(eq(contentRevisions.entryId, s.entries[1]!.id));
  await db
    .update(contentEntries)
    .set({ originalPublishedAt: new Date("2027-01-01T00:00:00Z") })
    .where(eq(contentEntries.id, s.entries[1]!.id));
  for (const query of ["%", "_", "\\", "'", "日本語🌸"]) {
    const r = await listPublishedArticles(db, s.companyId, { ...filters, query });
    expect(r.total).toBe(1);
    expect(r.items[0]!.slug).toBe("article-2");
    expect(r.items[0]!.excerpt).not.toContain("日本語");
  }
  expect((await listPublishedArticles(db, s.companyId, filters)).items[0]!.publishedAt).toEqual(
    new Date("2027-01-01T00:00:00Z"),
  );
  expect((await findPublishedArticle(db, s.companyId, "article-2"))?.body).toContain("日本語🌸");
});
it("同時刻はID順、同一ミリ秒内はDBの精度で順序を保つ", async () => {
  const s = await setup(3),
    a = s.entries[0]!.id,
    b = s.entries[1]!.id;
  await db.execute(sql`update content_entries set published_at='2026-10-17T00:00:00.000900Z' where id=${a}`);
  await db.execute(sql`update content_entries set published_at='2026-10-17T00:00:00.000100Z' where id=${b}`);
  expect((await listPublishedArticles(db, s.companyId, filters)).items.slice(0, 2).map((a) => a.id)).toEqual([a, b]);
  await db.execute(sql`update content_entries set published_at='2026-10-17T00:00:00Z'`);
  expect((await listPublishedArticles(db, s.companyId, filters)).items.map((a) => a.id)).toEqual(
    s.entries
      .map((e) => e.id)
      .sort()
      .reverse(),
  );
});
it("空の会社・不正な条件・存在しない記事を区別する", async () => {
  const s = await setup();
  for (const patch of [
    { page: 0 },
    { page: -1 },
    { page: 1.5 },
    { page: NaN },
    { page: Infinity },
    { query: "x".repeat(121) },
    { query: "bad\0input" },
    { category: "private" },
  ])
    await expect(listPublishedArticles(db, s.companyId, { ...filters, ...patch } as typeof filters)).rejects.toThrow(
      "検索条件",
    );
  await expect(listPublishedArticles(db, "invalid", filters)).rejects.toThrow("企業");
  expect(await findPublishedArticle(db, s.companyId, "../article-1")).toBeNull();
  expect((await listPublishedArticles(db, randomUUID(), filters)).total).toBe(0);
  expect((await listPublishedArticles(db, s.companyId, { ...filters, page: Number.MAX_SAFE_INTEGER })).items).toEqual(
    [],
  );
});
