import type { ContentCompanyFilters, ManagedArticleFilters } from "@siteoffer/core";

type Search = Record<string, string | string[] | undefined>;
export type ContentIndexQuery = {
  companyId: string | null;
  entryId: string | null;
  view: "list" | "new" | "edit";
  filters: ManagedArticleFilters;
  companies: ContentCompanyFilters;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: string) =>
  value.length <= 120 && !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const page = (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
export function parseContentIndexQuery(sp: Search): ContentIndexQuery | null {
  const {
    company,
    entry,
    q = "",
    category = "all",
    publication = "all",
    page: p = "1",
    companyQuery = "",
    companyPage = "1",
    new: create,
  } = sp;
  if (
    [company, entry, q, category, publication, p, companyQuery, companyPage, create].some(
      (v) => v !== undefined && typeof v !== "string",
    )
  )
    return null;
  if (
    (company !== undefined && !uuid.test(company as string)) ||
    (entry !== undefined && (!company || !uuid.test(entry as string))) ||
    (create !== undefined && create !== "1") ||
    (create !== undefined && entry !== undefined) ||
    !text(q as string) ||
    !text(companyQuery as string) ||
    !page(p as string) ||
    !page(companyPage as string) ||
    !["all", "news", "blog"].includes(category as string) ||
    !["all", "unpublished", "published", "changes"].includes(publication as string)
  )
    return null;
  return {
    companyId: (company as string | undefined) ?? null,
    entryId: (entry as string | undefined) ?? null,
    view: entry ? "edit" : create ? "new" : "list",
    filters: {
      page: Number(p),
      query: (q as string).trim(),
      category: category as ManagedArticleFilters["category"],
      publication: publication as ManagedArticleFilters["publication"],
    },
    companies: { page: Number(companyPage), query: (companyQuery as string).trim() },
  };
}
export function contentIndexParams(query: ContentIndexQuery) {
  const params = new URLSearchParams();
  if (query.companyId) params.set("company", query.companyId);
  if (query.view === "edit" && query.entryId) params.set("entry", query.entryId);
  if (query.view === "new") params.set("new", "1");
  if (query.filters.query) params.set("q", query.filters.query);
  if (query.filters.category !== "all") params.set("category", query.filters.category);
  if (query.filters.publication !== "all") params.set("publication", query.filters.publication);
  if (query.filters.page !== 1) params.set("page", String(query.filters.page));
  if (query.companies.query) params.set("companyQuery", query.companies.query);
  if (query.companies.page !== 1) params.set("companyPage", String(query.companies.page));
  return params;
}
export function contentIndexHref(base: string, query: ContentIndexQuery) {
  const params = contentIndexParams(query);
  return base + (params.size ? `?${params}` : "");
}
export function keepsArticleEditor(query: ContentIndexQuery, scope: { companyId: string; entryId: string | null }) {
  return (
    query.companyId?.toLowerCase() === scope.companyId.toLowerCase() &&
    (query.entryId?.toLowerCase() ?? null) === (scope.entryId?.toLowerCase() ?? null) &&
    query.view === (scope.entryId ? "edit" : "new")
  );
}
