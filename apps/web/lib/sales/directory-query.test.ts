import { describe, expect, it } from "vitest";
import { directoryHref, directoryParams, normalizeDirectoryFilter, parseDirectoryQuery } from "./directory-query";

describe("営業候補の検索URL", () => {
  it("全検索条件を一覧・比較画面の間で保持する", () => {
    const query = parseDirectoryQuery({
      q: " 設計 & %_ ",
      prefecture: "愛知県",
      city: "名古屋市",
      industry: "設計",
      sort: "score_desc",
      assignment: "other",
      page: "13",
    });
    expect(query).not.toBeNull();
    const href = directoryHref("/sales/companies/fixture", query!);
    expect(parseDirectoryQuery(Object.fromEntries(new URL(href, "https://example.test").searchParams))).toEqual(query);
    expect(directoryParams(query!).get("q")).toBe("設計 & %_");
  });
  it("既定値を短いURLにして、条件変更時にページだけを戻せる", () => {
    const query = normalizeDirectoryFilter({})!;
    expect(directoryHref("/sales/companies", query)).toBe("/sales/companies");
    expect(parseDirectoryQuery({})).toEqual(query);
    const changed = parseDirectoryQuery({ q: "企業", page: "2", assignment: "mine" })!;
    expect(directoryParams({ ...changed, page: 1 }).has("page")).toBe(false);
    expect(directoryParams({ ...changed, page: 1 }).get("assignment")).toBe("mine");
  });
  it("重複・曖昧なページ・不正な条件を受け付けない", () => {
    for (const params of [
      { q: ["a", "b"] },
      { assignment: ["all", "mine"] },
      { page: "0" },
      { page: "01" },
      { page: "1e2" },
      { page: "1.1" },
      { page: "9007199254740992" },
      { query: "unused", sort: "wrong" },
      { assignment: "__proto__" },
      { q: "a\n" },
      { q: "a".repeat(121) },
    ])
      expect(parseDirectoryQuery(params)).toBeNull();
  });
});
