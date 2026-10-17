import { contentEntries, contentRevisions, type DbOrTx } from "@siteoffer/db";
import { and, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import { ContentError } from "./content-auth.ts";

export const ARTICLE_PAGE_SIZE = 20;
export type ArticleFilters = { page: number; query: string; category: "all" | "news" | "blog" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const publishedAt =
  sql<Date | null>`coalesce(${contentEntries.originalPublishedAt}, ${contentEntries.publishedAt})`.mapWith(
    contentEntries.publishedAt,
  );
const columns = {
  id: contentEntries.id,
  slug: contentEntries.slug,
  publishedAt,
  revision: contentRevisions.revision,
  title: contentRevisions.title,
  category: contentRevisions.category,
};
const publishedRevision = and(
  eq(contentRevisions.entryId, contentEntries.id),
  eq(contentRevisions.revision, contentEntries.publishedRevision),
);
function scope(companyId: string) {
  if (!uuid.test(companyId)) throw new ContentError("企業を確認してください");
  return and(eq(contentEntries.companyId, companyId), isNotNull(contentEntries.publishedRevision));
}
/** Public access still requires a published site; private previews must authorize their actor first. */
export async function listPublishedArticles(db: DbOrTx, companyId: string, filters: ArticleFilters) {
  const company = scope(companyId);
  if (
    !filters ||
    !Number.isSafeInteger(filters.page) ||
    filters.page < 1 ||
    typeof filters.query !== "string" ||
    filters.query.length > 120 ||
    Array.from(filters.query).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    !["all", "news", "blog"].includes(filters.category)
  )
    throw new ContentError("記事の検索条件を確認してください");
  const query = filters.query.trim();
  const literal = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
  const where = and(
    company,
    filters.category === "all" ? undefined : eq(contentRevisions.category, filters.category),
    query ? or(ilike(contentRevisions.title, literal), ilike(contentRevisions.body, literal)) : undefined,
  );
  return db.transaction(
    async (tx) => {
      const [count] = await tx
        .select({ total: sql<number>`count(*)`.mapWith(Number) })
        .from(contentEntries)
        .innerJoin(contentRevisions, publishedRevision)
        .where(where);
      const total = count!.total;
      const pageCount = Math.max(1, Math.ceil(total / ARTICLE_PAGE_SIZE));
      const items =
        filters.page > pageCount
          ? []
          : await tx
              .select({ ...columns, excerpt: sql<string>`left(${contentRevisions.body}, 280)` })
              .from(contentEntries)
              .innerJoin(contentRevisions, publishedRevision)
              .where(where)
              .orderBy(desc(publishedAt), desc(contentEntries.id))
              .limit(ARTICLE_PAGE_SIZE)
              .offset((filters.page - 1) * ARTICLE_PAGE_SIZE);
      return { filters: { ...filters, query }, items, total, pageCount, pageSize: ARTICLE_PAGE_SIZE };
    },
    { isolationLevel: "repeatable read" },
  );
}
export async function findPublishedArticle(db: DbOrTx, companyId: string, slug: string) {
  const company = scope(companyId);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) return null;
  const [article] = await db
    .select({ ...columns, body: contentRevisions.body })
    .from(contentEntries)
    .innerJoin(contentRevisions, publishedRevision)
    .where(and(company, eq(contentEntries.slug, slug)))
    .limit(1);
  return article ?? null;
}
export type PublishedArticlePage = Awaited<ReturnType<typeof listPublishedArticles>>;
export type PublishedArticle = NonNullable<Awaited<ReturnType<typeof findPublishedArticle>>>;
export type PublishedArticlesView =
  | { kind: "list"; data: PublishedArticlePage }
  | { kind: "article"; article: PublishedArticle; filters: ArticleFilters };
