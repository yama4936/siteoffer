import { randomUUID } from "node:crypto";
import {
  auditEvents,
  companies,
  contentEntries,
  contentImports,
  contentRevisions,
  type Db,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import { publishArticle, publishedArticles, saveArticle } from "./content.ts";
import { commitArticleImport, previewArticleImport } from "./content-import.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw Error(r.error);
  return r.value;
}
const article = {
  slug: "old-news",
  title: "元の記事",
  body: "引き継ぐ本文",
  category: "news",
  sourceUrl: "https://example.test/old-news",
  originalPublishedAt: "2020-01-02",
};
async function setup() {
  const [u] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test`, passwordHash: "x", displayName: "架空運営", role: "ops" })
    .returning();
  const [c] = await db.insert(companies).values({ name: "架空企業" }).returning();
  return {
    ops: { kind: "ops" as const, userId: u!.id },
    companyId: c!.id,
    source: { companyId: c!.id, format: "json" as const, fileName: "articles.json", text: JSON.stringify([article]) },
  };
}
async function confirmed(s: Awaited<ReturnType<typeof setup>>) {
  const preview = must(await previewArticleImport(db, s.ops, s.source));
  expect(preview.errors).toEqual([]);
  return { ...s.source, requestId: randomUUID(), fingerprint: preview.fingerprint, confirmed: true as const };
}
it("取り込みは下書きだけを作り、元日付・出典と履歴を保持する", async () => {
  const s = await setup(),
    input = await confirmed(s),
    saved = must(await commitArticleImport(db, clock, s.ops, input));
  expect(saved.importedCount).toBe(1);
  expect(await publishedArticles(db, s.companyId)).toEqual([]);
  const [e] = await db.select().from(contentEntries);
  expect(e).toMatchObject({
    importId: saved.id,
    publishedRevision: null,
    publishedAt: null,
    originalPublishedAt: new Date("2020-01-02"),
    sourceUrl: article.sourceUrl,
  });
  expect((await db.select().from(contentImports))[0]!.entryIds).toEqual([e!.id]);
  await publishArticle(db, clock, s.ops, {
    companyId: s.companyId,
    entryId: e!.id,
    expectedRevision: 1,
    expectedPublicationRevision: 0,
    revision: 1,
  });
  expect((await publishedArticles(db, s.companyId))[0]!.publishedAt).toEqual(new Date("2020-01-02"));
  expect(must(await commitArticleImport(db, clock, s.ops, input))).toMatchObject({
    id: saved.id,
    alreadyRecorded: true,
  });
  expect(await db.select().from(contentImports)).toHaveLength(1);
  expect(await db.select().from(contentRevisions)).toHaveLength(1);
});
it("既存の同一・異なる内容を区別し、掲載版も下書きも上書きしない", async () => {
  const s = await setup();
  must(await commitArticleImport(db, clock, s.ops, await confirmed(s)));
  const original = (await db.select().from(contentEntries))[0]!;
  await publishArticle(db, clock, s.ops, {
    companyId: s.companyId,
    entryId: original.id,
    expectedRevision: 1,
    expectedPublicationRevision: 0,
    revision: 1,
  });
  expect(must(await previewArticleImport(db, s.ops, s.source)).rows[0]!.status).toBe("identical");
  s.source.text = JSON.stringify([
    { ...article, title: "上書きしない" },
    { ...article, slug: "new-news", title: "追加" },
  ]);
  expect(must(await previewArticleImport(db, s.ops, s.source)).rows.map((r) => r.status)).toEqual(["conflict", "new"]);
  expect(must(await commitArticleImport(db, clock, s.ops, await confirmed(s)))).toMatchObject({
    importedCount: 1,
    skippedCount: 1,
  });
  expect((await publishedArticles(db, s.companyId))[0]!.title).toBe(article.title);
  expect((await db.select().from(contentEntries).where(eq(contentEntries.id, original.id)))[0]!.currentRevision).toBe(
    1,
  );
});
it("プレビュー後の追加を拒否して部分的に保存しない", async () => {
  const s = await setup(),
    input = await confirmed(s);
  await saveArticle(db, clock, s.ops, { companyId: s.companyId, ...article });
  expect(await commitArticleImport(db, clock, s.ops, input)).toMatchObject({ ok: false, error: "conflict" });
  expect(await db.select().from(contentImports)).toHaveLength(0);
  expect(await db.select().from(contentEntries)).toHaveLength(1);
});
it("不正行・別企業の書き出し・秘密情報・確認なしでは保存しない", async () => {
  const s = await setup(),
    input = await confirmed(s);
  expect(await commitArticleImport(db, clock, s.ops, { ...input, confirmed: false })).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
  for (const text of [
    JSON.stringify([article, { ...article, slug: "INVALID" }]),
    JSON.stringify([{ ...article, body: "パスワード: example-private-password" }]),
    JSON.stringify({
      schemaVersion: 1,
      companyId: randomUUID(),
      articles: [{ slug: article.slug, currentRevision: 1, revisions: [{ ...article, revision: 1 }] }],
    }),
  ]) {
    const source = { ...s.source, text },
      p = must(await previewArticleImport(db, s.ops, source));
    expect(p.errors.length).toBeGreaterThan(0);
    expect(
      await commitArticleImport(db, clock, s.ops, { ...input, ...source, fingerprint: p.fingerprint }),
    ).toMatchObject({ ok: false, error: "invalid_input" });
  }
  expect(await db.select().from(contentEntries)).toHaveLength(0);
});
it("営業・利用停止運営はプレビュー・取込・既存記事の編集と掲載もできない", async () => {
  const s = await setup(),
    input = await confirmed(s),
    sales = { kind: "sales" as const, userId: s.ops.userId };
  expect(await previewArticleImport(db, sales, s.source)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await commitArticleImport(db, clock, sales, input)).toMatchObject({ ok: false, error: "forbidden" });
  const e = await saveArticle(db, clock, s.ops, { companyId: s.companyId, ...article });
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  expect(await previewArticleImport(db, s.ops, s.source)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await commitArticleImport(db, clock, s.ops, input)).toMatchObject({ ok: false, error: "forbidden" });
  await expect(
    saveArticle(db, clock, s.ops, { companyId: s.companyId, ...article, entryId: e.id, expectedRevision: 1 }),
  ).rejects.toThrow("有効な運営");
  await expect(
    publishArticle(db, clock, s.ops, {
      companyId: s.companyId,
      entryId: e.id,
      expectedRevision: 1,
      expectedPublicationRevision: 0,
      revision: 1,
    }),
  ).rejects.toThrow("有効な運営");
});
it("監査保存の失敗で取り込み履歴と全記事を巻き戻す", async () => {
  const s = await setup();
  s.source.text = JSON.stringify([article, { ...article, slug: "another" }]);
  const input = await confirmed(s);
  await db.execute(
    sql`create function fail_content_import() returns trigger language plpgsql as $$ begin if NEW.action='content.import' then raise exception 'fixture failure'; end if; return NEW; end $$`,
  );
  await db.execute(
    sql`create trigger fail_content_import before insert on audit_events for each row execute function fail_content_import()`,
  );
  await expect(commitArticleImport(db, clock, s.ops, input)).rejects.toThrow();
  expect(await db.select().from(contentImports)).toHaveLength(0);
  expect(await db.select().from(contentEntries)).toHaveLength(0);
  expect(await db.select().from(contentRevisions)).toHaveLength(0);
});
it("同一受付の別内容は拒否し、別受付の再取込も重複記事を作らない", async () => {
  const s = await setup(),
    input = await confirmed(s);
  must(await commitArticleImport(db, clock, s.ops, input));
  expect(await commitArticleImport(db, clock, s.ops, { ...input, fileName: "changed.json" })).toMatchObject({
    ok: false,
    error: "request_conflict",
  });
  expect(await commitArticleImport(db, clock, s.ops, await confirmed(s))).toMatchObject({
    ok: false,
    error: "no_new_articles",
  });
  expect(await db.select().from(contentImports)).toHaveLength(1);
  expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "content.import"))).toHaveLength(1);
});

it("上限100件を一回の受付で保存し、全件を未掲載にする", async () => {
  const s = await setup();
  s.source.text = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ ...article, slug: `batch-${i}` })));
  expect(must(await commitArticleImport(db, clock, s.ops, await confirmed(s))).importedCount).toBe(100);
  const entries = await db.select().from(contentEntries);
  expect(entries).toHaveLength(100);
  expect(entries.every((e) => e.publishedRevision === null)).toBe(true);
  expect(await db.select().from(contentRevisions)).toHaveLength(100);
});
