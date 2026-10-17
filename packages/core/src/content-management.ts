import {
  companies,
  contentAccess,
  contentEntries,
  contentRevisions,
  contracts,
  type DbOrTx,
  users,
} from "@siteoffer/db";
import { and, desc, eq, ilike, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Actor } from "./common/actor.ts";
import { activeContentOperator, authorizeContentReader, ContentError } from "./content-auth.ts";

export const CONTENT_INDEX_PAGE_SIZE = 20;
export type ManagedArticleFilters = {
  page: number;
  query: string;
  category: "all" | "news" | "blog";
  publication: "all" | "unpublished" | "published" | "changes";
};
export type ContentCompanyFilters = { page: number; query: string };
function normalize(filters: ContentCompanyFilters) {
  if (
    !filters ||
    !Number.isSafeInteger(filters.page) ||
    filters.page < 1 ||
    typeof filters.query !== "string" ||
    filters.query.length > 120 ||
    Array.from(filters.query).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new ContentError("検索条件とページを確認してください");
  return { ...filters, query: filters.query.trim() };
}
const literal = (query: string) => `%${query.replace(/[%_\\]/g, "\\$&")}%`;
const published = alias(contentRevisions, "managed_published_revision");
const latestJoin = and(
  eq(contentRevisions.entryId, contentEntries.id),
  eq(contentRevisions.revision, contentEntries.currentRevision),
);
const publicJoin = and(
  eq(published.entryId, contentEntries.id),
  eq(published.revision, contentEntries.publishedRevision),
);

/** Transfer only twenty summaries; search current drafts and the currently published revision. */
export async function listManagedArticles(
  db: DbOrTx,
  actor: Actor | null,
  companyId: string,
  input: ManagedArticleFilters,
) {
  const filters = normalize(input);
  if (
    !["all", "news", "blog"].includes(input.category) ||
    !["all", "unpublished", "published", "changes"].includes(input.publication)
  )
    throw new ContentError("記事の種類と掲載状態を確認してください");
  const pattern = literal(filters.query);
  const where = and(
    eq(contentEntries.companyId, companyId),
    input.category === "all" ? undefined : eq(contentRevisions.category, input.category),
    input.publication === "unpublished"
      ? isNull(contentEntries.publishedRevision)
      : input.publication === "published"
        ? isNotNull(contentEntries.publishedRevision)
        : input.publication === "changes"
          ? and(
              isNotNull(contentEntries.publishedRevision),
              ne(contentEntries.currentRevision, contentEntries.publishedRevision),
            )
          : undefined,
    filters.query
      ? or(
          ilike(contentRevisions.title, pattern),
          ilike(contentRevisions.body, pattern),
          ilike(published.title, pattern),
          ilike(published.body, pattern),
          ilike(contentEntries.slug, pattern),
          ilike(contentEntries.sourceUrl, pattern),
        )
      : undefined,
  );
  return db.transaction(
    async (tx) => {
      await authorizeContentReader(tx, actor, companyId);
      const [count] = await tx
        .select({ total: sql<number>`count(*)`.mapWith(Number) })
        .from(contentEntries)
        .innerJoin(contentRevisions, latestJoin)
        .leftJoin(published, publicJoin)
        .where(where);
      const total = count!.total,
        pageCount = Math.max(1, Math.ceil(total / CONTENT_INDEX_PAGE_SIZE));
      const page = Math.min(filters.page, pageCount);
      const rows = await tx
        .select({
          id: contentEntries.id,
          slug: contentEntries.slug,
          title: contentRevisions.title,
          publishedTitle: published.title,
          category: contentRevisions.category,
          currentRevision: contentEntries.currentRevision,
          publishedRevision: contentEntries.publishedRevision,
          publicationRevision: contentEntries.publicationRevision,
          updatedAt: contentEntries.updatedAt,
        })
        .from(contentEntries)
        .innerJoin(contentRevisions, latestJoin)
        .leftJoin(published, publicJoin)
        .where(where)
        .orderBy(desc(contentEntries.updatedAt), desc(contentEntries.id))
        .limit(CONTENT_INDEX_PAGE_SIZE)
        .offset((page - 1) * CONTENT_INDEX_PAGE_SIZE);
      return {
        filters: { ...input, query: filters.query, page },
        items: rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
        total,
        pageCount,
        pageSize: CONTENT_INDEX_PAGE_SIZE,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}
export type ManagedArticlePage = Awaited<ReturnType<typeof listManagedArticles>>;

/** Search every authorized company, independent from the currently open article. */
export async function listContentManagementCompanies(db: DbOrTx, actor: Actor | null, input: ContentCompanyFilters) {
  const filters = normalize(input);
  if (
    (actor?.kind !== "ops" && actor?.kind !== "customer_user") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor.userId)
  )
    throw new ContentError("有効な記事管理のアカウントが必要です");
  return db.transaction(
    async (tx) => {
      if (actor.kind === "ops") await activeContentOperator(tx, actor, false);
      else {
        const [u] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, actor.userId), eq(users.role, "customer"), eq(users.status, "active")));
        if (!u) throw new ContentError("有効な顧客アカウントが必要です");
      }
      const pattern = literal(filters.query);
      const where = and(
        filters.query
          ? or(ilike(companies.name, pattern), ilike(companies.prefecture, pattern), ilike(companies.city, pattern))
          : undefined,
        actor.kind === "customer_user"
          ? sql`exists (select 1 from ${contentAccess} inner join ${contracts} on ${contracts.id}=${contentAccess.contractId} and ${contracts.companyId}=${contentAccess.companyId} and ${contracts.status}='completed' where ${contentAccess.companyId}=${companies.id} and ${contentAccess.userId}=${actor.userId} and ${contentAccess.status}='active')`
          : undefined,
      );
      const [count] = await tx
        .select({ total: sql<number>`count(*)`.mapWith(Number) })
        .from(companies)
        .where(where);
      const total = count!.total,
        pageCount = Math.max(1, Math.ceil(total / CONTENT_INDEX_PAGE_SIZE)),
        page = Math.min(filters.page, pageCount);
      const items = await tx
        .select({ id: companies.id, name: companies.name, prefecture: companies.prefecture, city: companies.city })
        .from(companies)
        .where(where)
        .orderBy(desc(companies.updatedAt), desc(companies.id))
        .limit(CONTENT_INDEX_PAGE_SIZE)
        .offset((page - 1) * CONTENT_INDEX_PAGE_SIZE);
      return { filters: { ...filters, page }, items, total, pageCount, pageSize: CONTENT_INDEX_PAGE_SIZE };
    },
    { isolationLevel: "repeatable read" },
  );
}
export type ContentManagementCompanyPage = Awaited<ReturnType<typeof listContentManagementCompanies>>;
