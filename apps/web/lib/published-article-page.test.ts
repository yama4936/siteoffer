import { createDeliveryForContract, fixedClock, publishArticle, saveArticle } from "@siteoffer/core";
import { contracts, type Db, deliveries } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedDeliveryBase } from "../../../packages/core/src/delivery/test-helpers.ts";
import { publishedArticleMetadata, readPublishedArticlePage } from "./published-article-page";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-19T00:00:00Z"),
  origin = "https://cms.example.test";
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});
vi.mock("@/lib/db", () => ({ getDb: () => db }));
async function fixture() {
  const base = await seedDeliveryBase(db);
  const delivery = await createDeliveryForContract(db, clock, base.ops, base.contract.id);
  if (!delivery.ok) throw Error(delivery.error);
  const entry = await saveArticle(db, clock, base.ops, {
    companyId: base.company.id,
    slug: "first-news",
    title: "掲載中のお知らせ",
    body: "公開している本文です。",
    category: "news",
  });
  await publishArticle(db, clock, base.ops, {
    companyId: base.company.id,
    entryId: entry.id,
    revision: 1,
    expectedRevision: 1,
    expectedPublicationRevision: 0,
  });
  return { ...base, entry, delivery: delivery.value.delivery };
}
async function published() {
  const f = await fixture();
  await db.update(deliveries).set({ status: "published" }).where(eq(deliveries.id, f.delivery.id));
  return f;
}
it("未公開サイト・不正条件・ない記事をメタデータでも公開しない", async () => {
  const f = await fixture();
  expect(await readPublishedArticlePage(db, f.company.id, { article: f.entry.slug })).toBeNull();
  await db.update(deliveries).set({ status: "published" }).where(eq(deliveries.id, f.delivery.id));
  for (const input of [{ article: "missing" }, { page: "999" }, { page: ["1", "2"] }, { article: "../private" }])
    expect(await readPublishedArticlePage(db, f.company.id, input)).toBeNull();
  expect(await readPublishedArticlePage(db, "invalid", {})).toBeNull();
  await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, f.contract.id));
  expect(await readPublishedArticlePage(db, f.company.id, {})).toBeNull();
});
it("掲載版から記事名・説明・日時を作り、非公開下書きや一覧の検索条件を混ぜない", async () => {
  const f = await published();
  await saveArticle(db, clock, f.ops, {
    companyId: f.company.id,
    entryId: f.entry.id,
    expectedRevision: 1,
    slug: f.entry.slug,
    title: "PRIVATE-DRAFT-TITLE",
    body: "PRIVATE-DRAFT-BODY",
    category: "blog",
  });
  const page = await readPublishedArticlePage(db, f.company.id, {
    article: f.entry.slug,
    q: "相談",
    page: "3",
    category: "blog",
  });
  expect(page).not.toBeNull();
  const metadata = publishedArticleMetadata(page!, { origin });
  expect(metadata.title).toBe(`掲載中のお知らせ | ${f.company.name}`);
  expect(metadata.description).toBe("公開している本文です。");
  expect(metadata.robots).toEqual({ index: true, follow: true });
  expect(metadata.alternates?.canonical).toBe(`${origin}/published/${f.company.id}/news?article=first-news`);
  expect(metadata.openGraph).toMatchObject({
    type: "article",
    publishedTime: clock.now().toISOString(),
    locale: "ja_JP",
  });
  expect(JSON.stringify(metadata)).not.toContain("PRIVATE-DRAFT");
  expect(JSON.stringify(metadata)).not.toContain("相談");
});
it("検索結果を索引から外し、カテゴリとページに対応する一覧の正規URLを作る", async () => {
  const f = await published(),
    list = (await readPublishedArticlePage(db, f.company.id, {}))!;
  const search = structuredClone(list);
  if (search.view.kind !== "list") throw Error("Expected list");
  search.view.data.filters = { page: 2, query: "相談", category: "blog" };
  const result = publishedArticleMetadata(search, { origin });
  expect(result.title).toBe(`記事の検索結果（2ページ目） | ${f.company.name}`);
  expect(result.robots).toEqual({ index: false, follow: true });
  const category = structuredClone(search);
  if (category.view.kind !== "list") throw Error("Expected list");
  category.view.data.filters.query = "";
  const metadata = publishedArticleMetadata(category, { origin });
  expect(metadata.title).toBe(`ブログ（2ページ目） | ${f.company.name}`);
  expect(metadata.alternates?.canonical).toBe(`${origin}/published/${f.company.id}/news?category=blog&page=2`);
  expect(metadata.robots).toEqual({ index: true, follow: true });
});
it("デモ・ローカル・配信元不明は索引へ出さず、不正な設定からURLを創作しない", async () => {
  const f = await published(),
    page = (await readPublishedArticlePage(db, f.company.id, {}))!;
  for (const value of [
    undefined,
    "",
    "https://user:secret@example.test",
    "javascript:alert(1)",
    "https://cms.example.test/subdir",
    "https://cms.example.test/?token=private",
    "https://cms.example.test/#private",
    "http://cms.example.test",
    "https://cms.example.test/\n",
  ]) {
    const metadata = publishedArticleMetadata(page, { origin: value });
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.robots).toMatchObject({ index: false });
    expect(JSON.stringify(metadata)).not.toContain("secret");
    expect(JSON.stringify(metadata)).not.toContain("private");
  }
  expect(publishedArticleMetadata(page, { origin, demo: true }).robots).toMatchObject({ index: false });
  for (const value of ["http://localhost:3100", "http://127.0.0.1:3100", "http://[::1]:3100"])
    expect(publishedArticleMetadata(page, { origin: value }).robots).toMatchObject({ index: false });
});
it("説明をUnicode単位で短くし、改行・余白と不正な日時を扱う", async () => {
  const f = await published(),
    page = (await readPublishedArticlePage(db, f.company.id, { article: f.entry.slug }))!;
  if (page.view.kind !== "article") throw Error("Expected article");
  page.view.article.body = `  説明\n\t${"🌸".repeat(200)}  `;
  page.view.article.publishedAt = new Date(Number.NaN);
  const metadata = publishedArticleMetadata(page, { origin });
  expect(Array.from(metadata.description!).length).toBe(160);
  expect(metadata.description).toMatch(/^説明 /);
  expect(metadata.description).toMatch(/🌸…$/);
  expect(metadata.openGraph).not.toHaveProperty("publishedTime");
  expect(metadata.twitter).toMatchObject({ card: "summary" });
  // The helper only returns public presentation fields, not the underlying record.
  expect(metadata).not.toHaveProperty("homeUrl");
});
it("公開ルートの本文とメタデータが同じ掲載版・公開判定を使う", async () => {
  const f = await published();
  vi.stubEnv("SITEOFFER_CONTENT_ORIGIN", origin);
  vi.stubEnv("SITEOFFER_DEMO_MODE", "false");
  vi.stubEnv("DEMO_RESTORE_DIR", "");
  const { default: Page, generateMetadata } = await import("@/app/published/[companyId]/news/page");
  const props = {
    params: Promise.resolve({ companyId: f.company.id }),
    searchParams: Promise.resolve({ article: f.entry.slug }),
  };
  expect((await generateMetadata(props)).title).toBe(`掲載中のお知らせ | ${f.company.name}`);
  expect((await Page(props)).props.view.article.title).toBe("掲載中のお知らせ");
  vi.stubEnv("SITEOFFER_DEMO_MODE", "true");
  expect((await generateMetadata(props)).robots).toMatchObject({ index: false });
  await db.update(deliveries).set({ status: "building" }).where(eq(deliveries.id, f.delivery.id));
  await expect(generateMetadata(props)).rejects.toThrow();
  await expect(Page(props)).rejects.toThrow();
});
