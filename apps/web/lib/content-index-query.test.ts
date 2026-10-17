import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { contentIndexHref, keepsArticleEditor, parseContentIndexQuery } from "./content-index-query";

it("既存の記事URLは編集、新規と一覧は明確に分ける", () => {
  const company = randomUUID(),
    entry = randomUUID();
  expect(parseContentIndexQuery({ company, entry })?.view).toBe("edit");
  expect(parseContentIndexQuery({ company, new: "1" })?.view).toBe("new");
  expect(parseContentIndexQuery({ company })?.view).toBe("list");
});
it("同じ編集対象を保つ検索だけを許容し、会社・記事・一覧への移動には入力保護を残す", () => {
  const companyId = randomUUID(),
    entryId = randomUUID(),
    scope = { companyId, entryId };
  const current = parseContentIndexQuery({ company: companyId, entry: entryId })!;
  expect(keepsArticleEditor({ ...current, filters: { ...current.filters, query: "変更", page: 3 } }, scope)).toBe(true);
  expect(keepsArticleEditor({ ...current, companies: { query: "名古屋", page: 2 } }, scope)).toBe(true);
  for (const candidate of [
    { ...current, companyId: randomUUID() },
    { ...current, entryId: randomUUID() },
    { ...current, view: "list" as const, entryId: null },
    { ...current, view: "new" as const, entryId: null },
  ])
    expect(keepsArticleEditor(candidate, scope)).toBe(false);
  const fresh = parseContentIndexQuery({ company: companyId, new: "1" })!;
  expect(keepsArticleEditor(fresh, { companyId, entryId: null })).toBe(true);
  expect(keepsArticleEditor({ ...fresh, view: "list" }, { companyId, entryId: null })).toBe(false);
});
it("記事・会社の検索条件を、編集・新規保存・一覧への往復で保持する", () => {
  const input = parseContentIndexQuery({
    company: randomUUID(),
    new: "1",
    q: " 日本語 % ",
    category: "blog",
    publication: "changes",
    page: "3",
    companyQuery: "名古屋",
    companyPage: "2",
  });
  expect(input).not.toBeNull();
  const entry = randomUUID(),
    url = new URL(
      contentIndexHref("/ops/content", { ...input!, view: "edit", entryId: entry }),
      "https://example.test",
    );
  expect(url.searchParams.get("new")).toBeNull();
  expect(url.searchParams.get("entry")).toBe(entry);
  expect(url.searchParams.get("q")).toBe("日本語 %");
  const restored = parseContentIndexQuery(Object.fromEntries(url.searchParams));
  expect(restored).toEqual({ ...input, view: "edit", entryId: entry });
  const back = new URL(contentIndexHref("/ops/content", { ...restored!, view: "list", entryId: null }), url);
  expect(back.searchParams.get("entry")).toBeNull();
  expect(back.searchParams.get("page")).toBe("3");
  expect(back.searchParams.get("companyQuery")).toBe("名古屋");
});
it("重複・不正ID・曖昧な編集先・不正ページ・過長な条件を拒否する", () => {
  const company = randomUUID(),
    entry = randomUUID();
  for (const input of [
    { company: [company, company] },
    { company, entry: [entry, entry] },
    { company, entry, new: "1" },
    { entry },
    { company: "bad" },
    { company, page: "0" },
    { company, page: "1.1" },
    { company, companyPage: "-1" },
    { company, q: "a".repeat(121) },
    { company, q: "\n" },
    { company, publication: "bad" },
    { company, new: "0" },
    { company, q: ["x", "y"] },
  ])
    expect(parseContentIndexQuery(input)).toBeNull();
});
