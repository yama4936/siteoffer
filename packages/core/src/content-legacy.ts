import { createHash } from "node:crypto";
import { contentEntries, contentRevisions, type DbOrTx } from "@siteoffer/db";
import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { recordEvent } from "./common/events.ts";
import type { Actor, Clock } from "./common/index.ts";
import { hasPublishedSite } from "./content.ts";
import { activeContentOperator, ContentError, lockContentCompany } from "./content-auth.ts";
import { articleLegacyPath, normalizeArticleLegacyPath } from "./content-legacy-path.ts";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const columns = {
  id: contentEntries.id,
  slug: contentEntries.slug,
  sourceUrl: contentEntries.sourceUrl,
  legacyPath: contentEntries.legacyPath,
  legacyRevision: contentEntries.legacyRevision,
  currentRevision: contentEntries.currentRevision,
  publishedRevision: contentEntries.publishedRevision,
  publicationRevision: contentEntries.publicationRevision,
};
type Row = Pick<typeof contentEntries.$inferSelect, keyof typeof columns>;
export type ArticleLegacySelection = { id: string; fingerprint: string; legacyRevision: number; path?: string };
const fingerprint = (row: Row) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        row.id,
        row.slug,
        row.sourceUrl,
        row.currentRevision,
        row.publishedRevision,
        row.publicationRevision,
      ]),
    )
    .digest("hex");
function operator(actor: Actor | null) {
  if (actor?.kind !== "ops" || !uuid.test(actor.userId)) throw new ContentError("有効な運営権限が必要です");
}
export async function listArticleLegacyPaths(
  db: DbOrTx,
  actor: Actor | null,
  companyId: string,
  input: { page: number; query: string; state: "all" | "active" | "inactive" },
) {
  operator(actor);
  if (
    !uuid.test(companyId) ||
    !input ||
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    typeof input.query !== "string" ||
    input.query.length > 120 ||
    Array.from(input.query).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    !["all", "active", "inactive"].includes(input.state)
  )
    throw new ContentError("旧URLの表示条件を確認してください");
  return db.transaction(
    async (tx) => {
      await activeContentOperator(tx, actor, false);
      const pattern = `%${input.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
      const where = and(
        eq(contentEntries.companyId, companyId),
        input.query.trim()
          ? or(
              ilike(contentEntries.sourceUrl, pattern),
              ilike(contentEntries.legacyPath, pattern),
              ilike(contentEntries.slug, pattern),
            )
          : undefined,
        input.state === "active"
          ? isNotNull(contentEntries.legacyPath)
          : input.state === "inactive"
            ? isNull(contentEntries.legacyPath)
            : undefined,
      );
      const [totalRow] = await tx.select({ total: count() }).from(contentEntries).where(where);
      const total = totalRow!.total,
        pages = Math.max(1, Math.ceil(total / 20)),
        page = Math.min(input.page, pages);
      const entries = await tx
        .select(columns)
        .from(contentEntries)
        .where(where)
        .orderBy(desc(contentEntries.updatedAt), desc(contentEntries.id))
        .limit(20)
        .offset((page - 1) * 20);
      const candidates = entries
        .map((row) => articleLegacyPath(row.sourceUrl))
        .filter((path): path is string => !!path);
      const active = candidates.length
        ? await tx
            .select({ id: contentEntries.id, path: contentEntries.legacyPath })
            .from(contentEntries)
            .where(and(eq(contentEntries.companyId, companyId), inArray(contentEntries.legacyPath, candidates)))
        : [];
      const sitePublished = await hasPublishedSite(tx, companyId);
      return {
        total,
        pages,
        page,
        query: input.query.trim(),
        state: input.state,
        sitePublished,
        items: entries.map((row) => {
          const path = articleLegacyPath(row.sourceUrl),
            conflict = !!path && active.some((item) => item.path === path && item.id !== row.id);
          return {
            ...row,
            path,
            conflict,
            fingerprint: fingerprint(row),
            target: `/published/${companyId}/news?article=${encodeURIComponent(row.slug)}`,
          };
        }),
      };
    },
    { isolationLevel: "repeatable read" },
  );
}
export type ArticleLegacyPage = Awaited<ReturnType<typeof listArticleLegacyPaths>>;
export async function changeArticleLegacyPaths(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  companyId: string,
  operation: "enable" | "disable",
  raw: unknown,
  confirmed: boolean,
) {
  operator(actor);
  if (
    confirmed !== true ||
    !["enable", "disable"].includes(operation) ||
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > 100 ||
    new Set(raw.map((item) => item?.id)).size !== raw.length ||
    raw.some(
      (item) =>
        !item ||
        typeof item.id !== "string" ||
        !uuid.test(item.id) ||
        typeof item.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
        !Number.isSafeInteger(item.legacyRevision) ||
        item.legacyRevision < 0 ||
        item.legacyRevision >= 2147483647 ||
        (item.path !== undefined && (typeof item.path !== "string" || item.path.length > 2048)),
    )
  )
    throw new ContentError("対象の記事と確認欄を確認してください。一度に100件まで操作できます");
  const selected = raw as ArticleLegacySelection[];
  return db.transaction(async (tx) => {
    await lockContentCompany(tx, companyId);
    await activeContentOperator(tx, actor, true);
    const rows = await tx
      .select(columns)
      .from(contentEntries)
      .where(
        and(
          eq(contentEntries.companyId, companyId),
          inArray(
            contentEntries.id,
            selected.map((item) => item.id),
          ),
        ),
      );
    if (rows.length !== selected.length) throw new ContentError("対象の記事を確認できません。対応表を更新してください");
    const changes = rows.map((row) => {
      const offered = selected.find((item) => item.id === row.id)!,
        path =
          operation === "enable"
            ? offered.path === undefined
              ? articleLegacyPath(row.sourceUrl)
              : normalizeArticleLegacyPath(offered.path)
            : null;
      if (operation === "enable" && !path)
        throw new ContentError("引き継げない旧URLがあります。対応表を確認してください");
      if (
        fingerprint(row) !== offered.fingerprint ||
        (row.legacyRevision !== offered.legacyRevision &&
          !(row.legacyRevision === offered.legacyRevision + 1 && row.legacyPath === path))
      )
        throw new ContentError("確認後に記事やURLの設定が変わりました。対応表を更新して選び直してください");
      return { row, path };
    });
    const desired = changes.map((item) => item.path).filter((path): path is string => !!path);
    if (new Set(desired).size !== desired.length)
      throw new ContentError("同じ旧URLを複数の記事へ割り当てられません。1件を選んでください");
    const conflicts = desired.length
      ? await tx
          .select({ id: contentEntries.id, path: contentEntries.legacyPath })
          .from(contentEntries)
          .where(and(eq(contentEntries.companyId, companyId), inArray(contentEntries.legacyPath, desired)))
      : [];
    if (conflicts.some((item) => changes.find((change) => change.path === item.path)?.row.id !== item.id))
      throw new ContentError("既に別の記事が使っている旧URLがあります。先にその引き継ぎを解除してください");
    let changed = 0;
    for (const { row, path } of changes)
      if (row.legacyPath !== path) {
        await tx
          .update(contentEntries)
          .set({ legacyPath: path, legacyRevision: row.legacyRevision + 1 })
          .where(eq(contentEntries.id, row.id));
        changed++;
      }
    if (changed)
      await recordEvent(tx, clock, {
        actor: actor!,
        action: `content.legacy.${operation}`,
        targetType: "company",
        targetId: companyId,
        after: {
          entryIds: selected.map((item) => item.id),
          changed,
          paths: changes
            .filter((item) => item.row.legacyPath !== item.path)
            .map((item) => ({ entryId: item.row.id, from: item.row.legacyPath, to: item.path })),
        },
      });
    return { changed, total: selected.length };
  });
}
/** No external target or draft metadata is ever returned by this public resolver. */
export async function resolveArticleLegacyPath(db: DbOrTx, companyId: string, rawPath: string) {
  if (!uuid.test(companyId)) return null;
  const path = normalizeArticleLegacyPath(rawPath);
  if (!path) return null;
  return db.transaction(
    async (tx) => {
      if (!(await hasPublishedSite(tx, companyId))) return null;
      const [entry] = await tx
        .select({ slug: contentEntries.slug })
        .from(contentEntries)
        .innerJoin(
          contentRevisions,
          and(
            eq(contentRevisions.entryId, contentEntries.id),
            eq(contentRevisions.revision, contentEntries.publishedRevision),
          ),
        )
        .where(
          and(
            eq(contentEntries.companyId, companyId),
            eq(contentEntries.legacyPath, path),
            isNotNull(contentEntries.publishedRevision),
          ),
        )
        .limit(1);
      return entry && /^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.slug)
        ? `/published/${companyId}/news?article=${encodeURIComponent(entry.slug)}`
        : null;
    },
    { isolationLevel: "repeatable read" },
  );
}
