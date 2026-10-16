import { fixedClock, hasPublishedSite, publishArticle, publishedArticles, saveArticle } from "@siteoffer/core";
import { contentRevisions, type Db } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { seedCandidate, seedUser } from "./test-seed";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-16T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
it("下書き・掲載版・差し戻し・掲載停止・競合を分離し、本文を失わない", async () => {
  const { actor } = await seedUser(db, "ops"),
    { actor: sales } = await seedUser(db, "sales"),
    { company } = await seedCandidate(db);
  const input = {
    companyId: company.id,
    slug: "first-news",
    title: "初回のお知らせ",
    body: "公開する内容\n<script>alert(1)</script>",
    category: "news",
  };
  await expect(saveArticle(db, clock, sales, input)).rejects.toThrow("運営権限");
  const entry = await saveArticle(db, clock, actor, input);
  expect(await publishedArticles(db, company.id)).toEqual([]);
  await publishArticle(db, clock, actor, { entryId: entry.id, expectedRevision: 1, revision: 1 });
  await saveArticle(db, clock, actor, {
    ...input,
    entryId: entry.id,
    expectedRevision: 1,
    title: "未掲載の修正",
    body: "まだ公開しない",
  });
  expect((await publishedArticles(db, company.id))[0]?.title).toBe("初回のお知らせ");
  await expect(saveArticle(db, clock, actor, { ...input, entryId: entry.id, expectedRevision: 1 })).rejects.toThrow(
    "別の担当者",
  );
  await publishArticle(db, clock, actor, { entryId: entry.id, expectedRevision: 2, revision: 2 });
  expect((await publishedArticles(db, company.id))[0]?.title).toBe("未掲載の修正");
  await publishArticle(db, clock, actor, { entryId: entry.id, expectedRevision: 2, revision: 1 });
  expect((await publishedArticles(db, company.id))[0]?.body).toContain("<script>");
  expect(await hasPublishedSite(db, company.id)).toBe(false);
  await publishArticle(db, clock, actor, { entryId: entry.id, expectedRevision: 2, revision: null });
  expect(await publishedArticles(db, company.id)).toEqual([]);
  expect(await db.select().from(contentRevisions)).toHaveLength(2);
});
