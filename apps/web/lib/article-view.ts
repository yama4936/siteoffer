import {
  type ArticleFilters,
  findPublishedArticle,
  listPublishedArticles,
  type PublishedArticlesView,
} from "@siteoffer/core";
import type { DbOrTx } from "@siteoffer/db";

type Search = Record<string, string | string[] | undefined>;
export function parseArticleQuery(sp: Search): { filters: ArticleFilters; slug: string | null } | null {
  const { page = "1", q = "", category = "all", article } = sp;
  if (
    typeof page !== "string" ||
    !/^[1-9]\d*$/.test(page) ||
    !Number.isSafeInteger(Number(page)) ||
    typeof q !== "string" ||
    q.length > 120 ||
    Array.from(q).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    (category !== "all" && category !== "news" && category !== "blog") ||
    (article !== undefined && (typeof article !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(article)))
  )
    return null;
  return { filters: { page: Number(page), query: q.trim(), category }, slug: article ?? null };
}
export function articleHref(base: string, filters: ArticleFilters, slug?: string) {
  const query = new URLSearchParams();
  if (filters.query) query.set("q", filters.query);
  if (filters.category !== "all") query.set("category", filters.category);
  if (filters.page !== 1) query.set("page", String(filters.page));
  if (slug) query.set("article", slug);
  return `${base}${query.size ? `?${query}` : ""}`;
}
export async function loadArticleView(
  db: DbOrTx,
  companyId: string,
  sp: Search,
): Promise<PublishedArticlesView | null> {
  const input = parseArticleQuery(sp);
  if (!input) return null;
  if (input.slug) {
    const article = await findPublishedArticle(db, companyId, input.slug);
    return article ? { kind: "article", article, filters: input.filters } : null;
  }
  const data = await listPublishedArticles(db, companyId, input.filters);
  return data.filters.page > data.pageCount ? null : { kind: "list", data };
}
