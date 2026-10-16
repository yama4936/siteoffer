import { expect, it } from "vitest";
import { ARTICLE_IMPORT_TEMPLATE, parseArticleImport } from "./content-import.ts";

const article = { slug: "hello", title: "お知らせ", body: "本文", category: "news" };
it("BOM・CRLF・引用符内改行・カンマ・エスケープを保持する", () => {
  const p = parseArticleImport(
    '\uFEFFslug,title,body,category\r\nhello,"お知らせ,更新","本文\r\n続き""引用""",news\r\n',
    "csv",
  );
  expect(p.errors).toEqual([]);
  expect(p.articles[0]).toMatchObject({ title: "お知らせ,更新", body: '本文\r\n続き"引用"' });
  expect(parseArticleImport(ARTICLE_IMPORT_TEMPLATE, "csv").errors).toEqual([]);
});
it.each([
  'slug,title,body,category\nx,"未完了,本文,news',
  'slug,title,body,category\nx,"見出し"x,本文,news',
  "slug,title,title,body,category\nx,a,b,c,news",
  "slug,title,body,category\nx,title,body,news,extra",
  "slug,title,body,category\nx,t,body,news\nx,t,body,news",
])("不正なCSVを受け付けない", (text) => expect(parseArticleImport(text, "csv").errors.length).toBeGreaterThan(0));
it("不正な日付・認証情報付きURL・危険なURL・NULを拒否する", () => {
  for (const change of [
    { originalPublishedAt: "2026-02-30" },
    { originalPublishedAt: 0 },
    { sourceUrl: false },
    { originalPublishedAt: "2026-01-01T12:00:00" },
    { sourceUrl: "https://user:pass@example.test/x" },
    { sourceUrl: "javascript:alert(1)" },
    { body: "a\0b" },
  ])
    expect(parseArticleImport(JSON.stringify([{ ...article, ...change }]), "json").errors.length).toBeGreaterThan(0);
  expect(
    parseArticleImport(JSON.stringify([{ ...article, originalPublishedAt: "2026-01-15T00:00:00+09:00" }]), "json")
      .articles[0]!.originalPublishedAt,
  ).toBe("2026-01-14T15:00:00.000Z");
});
it("JSON書き出しから現下書き版と元日付だけを選ぶ", () => {
  const p = parseArticleImport(
    JSON.stringify({
      schemaVersion: 1,
      companyId: "00000000-0000-4000-8000-000000000001",
      articles: [
        {
          slug: "hello",
          currentRevision: 2,
          publishedRevision: 1,
          publishedAt: "2020-01-01T00:00:00Z",
          revisions: [
            { ...article, revision: 1, title: "旧版" },
            { ...article, revision: 2, title: "新版" },
          ],
        },
      ],
    }),
    "json",
  );
  expect(p.errors).toEqual([]);
  expect(p.articles[0]).toMatchObject({ title: "新版", originalPublishedAt: "2020-01-01T00:00:00.000Z" });
  expect(p.warnings).toHaveLength(1);
});
it("HTMLは変換・実行せず警告し、100件・2MB制限を守る", () => {
  const p = parseArticleImport(JSON.stringify([{ ...article, body: "<img src=x onerror=alert(1)>" }]), "json");
  expect(p.errors).toEqual([]);
  expect(p.warnings).toHaveLength(1);
  expect(p.articles[0]!.body).toContain("onerror");
  expect(
    parseArticleImport(JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ ...article, slug: `a${i}` }))), "json")
      .errors,
  ).not.toEqual([]);
  expect(parseArticleImport("あ".repeat(800000), "csv").errors[0]!.message).toContain("2MB");
});
