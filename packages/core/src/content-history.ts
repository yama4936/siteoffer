import { contentEntries, contentRevisions, type DbOrTx } from "@siteoffer/db";
import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import type { Actor } from "./common/index.ts";
import { authorizeContentReader, ContentError } from "./content-auth.ts";
import type { ArticleScope } from "./content-workspace.ts";

export type ArticleSnapshot = Pick<
  typeof contentRevisions.$inferSelect,
  "revision" | "title" | "body" | "category" | "images"
>;
export type ArticleHistoryFilters = { page: number; query: string };
export type ArticleHistorySummary = { revision: number; title: string; category: string; createdAt: string };
export type ArticleHistoryPage = {
  filters: ArticleHistoryFilters;
  items: ArticleHistorySummary[];
  total: number;
  pageCount: number;
  pageSize: number;
};
export const ARTICLE_HISTORY_PAGE_SIZE = 20;
export class ArticleHistoryError extends ContentError {
  readonly code: "invalid_input" | "not_found";
  constructor(code: "invalid_input" | "not_found") {
    super(code === "invalid_input" ? "履歴の検索条件・版を確認してください" : "記事の版がありません");
    this.code = code;
  }
}
function filters(input: ArticleHistoryFilters): ArticleHistoryFilters {
  if (
    !input ||
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    typeof input.query !== "string" ||
    input.query.length > 120 ||
    Array.from(input.query).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new ArticleHistoryError("invalid_input");
  return { page: input.page, query: input.query.trim() };
}
export function emptyArticleHistory(): ArticleHistoryPage {
  return { filters: { page: 1, query: "" }, items: [], total: 0, pageCount: 1, pageSize: ARTICLE_HISTORY_PAGE_SIZE };
}
/** Internal: the caller already authorized this article in its transaction. No bodies or image references leave the history index. */
export async function readArticleHistoryIndex(
  db: DbOrTx,
  entryId: string,
  input: ArticleHistoryFilters,
): Promise<ArticleHistoryPage> {
  const f = filters(input),
    pattern = `%${f.query.replace(/[\\%_]/g, "\\$&")}%`;
  const where = and(
    eq(contentRevisions.entryId, entryId),
    f.query ? or(ilike(contentRevisions.title, pattern), ilike(contentRevisions.body, pattern)) : undefined,
  );
  const [n] = await db.select({ total: count() }).from(contentRevisions).where(where);
  const total = n!.total,
    pageCount = Math.max(1, Math.ceil(total / ARTICLE_HISTORY_PAGE_SIZE)),
    page = Math.min(f.page, pageCount);
  const rows = await db
    .select({
      revision: contentRevisions.revision,
      title: contentRevisions.title,
      category: contentRevisions.category,
      createdAt: contentRevisions.createdAt,
    })
    .from(contentRevisions)
    .where(where)
    .orderBy(desc(contentRevisions.revision))
    .limit(ARTICLE_HISTORY_PAGE_SIZE)
    .offset((page - 1) * ARTICLE_HISTORY_PAGE_SIZE);
  return {
    filters: { ...f, page },
    total,
    pageCount,
    pageSize: ARTICLE_HISTORY_PAGE_SIZE,
    items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  };
}
async function authorizeArticleRead(db: DbOrTx, actor: Actor | null, scope: ArticleScope) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!scope || !uuid.test(scope.companyId) || !scope.entryId || !uuid.test(scope.entryId))
    throw new ArticleHistoryError("invalid_input");
  if (!actor || !("userId" in actor) || !uuid.test(actor.userId))
    throw new ContentError("有効な記事更新権限が必要です");
  await authorizeContentReader(db, actor, scope.companyId);
  const [entry] = await db
    .select({ id: contentEntries.id })
    .from(contentEntries)
    .where(and(eq(contentEntries.companyId, scope.companyId), eq(contentEntries.id, scope.entryId)));
  if (!entry) throw new ArticleHistoryError("not_found");
}
export async function loadArticleHistory(
  db: DbOrTx,
  actor: Actor | null,
  scope: ArticleScope,
  input: ArticleHistoryFilters,
) {
  const f = filters(input);
  return db.transaction(
    async (tx) => {
      await authorizeArticleRead(tx, actor, scope);
      return readArticleHistoryIndex(tx, scope.entryId!, f);
    },
    { isolationLevel: "repeatable read" },
  );
}
export async function loadArticleRevision(
  db: DbOrTx,
  actor: Actor | null,
  scope: ArticleScope,
  revision: number,
): Promise<ArticleSnapshot> {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647)
    throw new ArticleHistoryError("invalid_input");
  return db.transaction(
    async (tx) => {
      await authorizeArticleRead(tx, actor, scope);
      const [row] = await tx
        .select({
          revision: contentRevisions.revision,
          title: contentRevisions.title,
          body: contentRevisions.body,
          category: contentRevisions.category,
          images: contentRevisions.images,
        })
        .from(contentRevisions)
        .where(and(eq(contentRevisions.entryId, scope.entryId!), eq(contentRevisions.revision, revision)));
      if (!row) throw new ArticleHistoryError("not_found");
      return row;
    },
    { isolationLevel: "repeatable read" },
  );
}
