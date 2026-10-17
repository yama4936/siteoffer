import { expect, it } from "vitest";
import { articleHref, parseArticleQuery } from "./article-view";

it("記事の検索条件を正規化し、詳細URLでも一覧の位置を保持する", () => {
  const v = parseArticleQuery({ q: "  古い記事  ", category: "blog", page: "26", article: "archive-501" })!;
  expect(v).toEqual({ filters: { query: "古い記事", category: "blog", page: 26 }, slug: "archive-501" });
  const href = articleHref("/published/fixture/news", v.filters, v.slug!);
  const url = new URL(href, "https://example.test");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    q: "古い記事",
    category: "blog",
    page: "26",
    article: "archive-501",
  });
  expect(articleHref("/published/fixture/news", { query: "", category: "all", page: 1 })).toBe(
    "/published/fixture/news",
  );
});
it("重複や不正な検索条件を無条件の一覧へ読み替えない", () => {
  for (const v of [
    { page: ["1", "2"] },
    { q: ["公開", "非公開"] },
    { category: ["news", "blog"] },
    { article: ["one", "two"] },
    { page: "0" },
    { page: "-1" },
    { page: "1.5" },
    { page: "1e2" },
    { page: "01" },
    { page: "9007199254740992" },
    { q: "x".repeat(121) },
    { q: "bad\ninput" },
    { category: "draft" },
    { article: "../private" },
    { article: "" },
  ])
    expect(parseArticleQuery(v)).toBeNull();
  expect(parseArticleQuery({})).toEqual({ filters: { page: 1, query: "", category: "all" }, slug: null });
});
