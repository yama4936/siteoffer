import { createHash } from "node:crypto";
import { companies, contentEntries, contentImports, contentRevisions, type DbOrTx, users } from "@siteoffer/db";
import {
  type ArticleImportSource,
  articleImportCommitSchema,
  articleImportSourceSchema,
  type ImportedArticle,
  parseArticleImport,
} from "@siteoffer/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { recordEvent } from "./common/events.ts";
import type { Actor, Clock } from "./common/index.ts";
import { err, ok } from "./common/result.ts";
import { ContentError } from "./content-auth.ts";
import { validateArticleImageSelection } from "./content-images.ts";
import { findSecretInFields } from "./domain-preference/secrets.ts";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
export type ArticleImportRow = {
  article: ImportedArticle;
  status: "new" | "identical" | "conflict";
  existingId: string | null;
  existingRevision: number | null;
};
export type ArticleImportPreview = {
  rows: ArticleImportRow[];
  errors: { row: number; message: string }[];
  warnings: string[];
  fingerprint: string;
  newCount: number;
  skippedCount: number;
};
async function allowed(db: DbOrTx, actor: Actor | null, lock = false) {
  if (actor?.kind !== "ops" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor.userId))
    return false;
  const q = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  return !!(await (lock ? q.for("share") : q))[0];
}
async function plan(db: DbOrTx, source: ArticleImportSource, actor: Actor): Promise<ArticleImportPreview> {
  const parsed = parseArticleImport(source.text, source.format);
  if (parsed.exportedCompanyId && parsed.exportedCompanyId !== source.companyId)
    parsed.errors.push({ row: 0, message: "別企業の書き出しです。対象企業を確認してください" });
  for (const [i, a] of parsed.articles.entries())
    if (findSecretInFields({ title: a.title, body: a.body, sourceUrl: a.sourceUrl ?? "" }))
      parsed.errors.push({ row: i + 1, message: "秘密情報らしき内容があります。元ファイルを確認してください" });
  for (const [i, a] of parsed.articles.entries()) {
    try {
      await validateArticleImageSelection(db, actor, source.companyId, a.images ?? []);
    } catch (e) {
      if (!(e instanceof ContentError)) throw e;
      parsed.errors.push({ row: i + 1, message: e.message });
    }
  }
  const slugs = parsed.articles.map((a) => a.slug);
  const existing = slugs.length
    ? await db
        .select({ entry: contentEntries, draft: contentRevisions })
        .from(contentEntries)
        .leftJoin(
          contentRevisions,
          and(
            eq(contentRevisions.entryId, contentEntries.id),
            eq(contentRevisions.revision, contentEntries.currentRevision),
          ),
        )
        .where(and(eq(contentEntries.companyId, source.companyId), inArray(contentEntries.slug, slugs)))
    : [];
  const rows: ArticleImportRow[] = parsed.articles.map((article) => {
    const before = existing.find((r) => r.entry.slug === article.slug),
      draft = before?.draft;
    const identical =
      draft?.title === article.title &&
      draft.body === article.body &&
      draft.category === article.category &&
      draft.images.length === (article.images ?? []).length &&
      draft.images.every((image, index) => {
        const other = article.images?.[index];
        return other && image.assetId === other.assetId && image.alt === other.alt && image.caption === other.caption;
      }) &&
      before!.entry.sourceUrl === article.sourceUrl &&
      before!.entry.originalPublishedAt?.toISOString() === (article.originalPublishedAt ?? undefined);
    return {
      article,
      status: !before ? "new" : identical ? "identical" : "conflict",
      existingId: before?.entry.id ?? null,
      existingRevision: before?.entry.currentRevision ?? null,
    };
  });
  const fingerprint = sha(
    JSON.stringify({ companyId: source.companyId, fileHash: sha(source.text), rows, errors: parsed.errors }),
  );
  return {
    rows,
    errors: parsed.errors,
    warnings: parsed.warnings,
    fingerprint,
    newCount: rows.filter((r) => r.status === "new").length,
    skippedCount: rows.filter((r) => r.status !== "new").length,
  };
}
export async function previewArticleImport(db: DbOrTx, actor: Actor | null, raw: unknown) {
  if (!(await allowed(db, actor))) return err("forbidden", "運営権限が必要です");
  const p = articleImportSourceSchema.safeParse(raw);
  if (!p.success) return err("invalid_input", "企業・ファイル名・形式・サイズを確認してください");
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, p.data.companyId));
  if (!company) return err("not_found", "企業がありません");
  return ok(await plan(db, p.data, actor!));
}
export async function commitArticleImport(db: DbOrTx, clock: Clock, actor: Actor | null, raw: unknown) {
  if (actor?.kind !== "ops") return err("forbidden", "運営権限が必要です");
  const p = articleImportCommitSchema.safeParse(raw);
  if (!p.success) return err("invalid_input", "プレビューと確認チェックを確認してください");
  const input = p.data;
  const payloadHash = sha(JSON.stringify(input));
  return db.transaction(async (tx) => {
    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .for("update");
    if (!(await allowed(tx, actor, true))) return err("forbidden", "運営権限が必要です");
    if (!company) return err("not_found", "企業がありません");
    const [receipt] = await tx.select().from(contentImports).where(eq(contentImports.requestId, input.requestId));
    if (receipt)
      return receipt.companyId === input.companyId &&
        receipt.createdBy === actor.userId &&
        receipt.payloadHash === payloadHash
        ? ok({
            id: receipt.id,
            importedCount: receipt.importedCount,
            skippedCount: receipt.skippedCount,
            alreadyRecorded: true,
          })
        : err("request_conflict", "受付番号と内容が一致しません。再度プレビューしてください");
    const preview = await plan(tx, input, actor);
    if (preview.errors.length) return err("invalid_input", "取り込めない行があります。元ファイルを修正してください");
    if (preview.fingerprint !== input.fingerprint)
      return err("conflict", "確認後に記事が更新されました。同じファイルを再照合してください");
    if (!preview.newCount) return err("no_new_articles", "新しく取り込む記事はありません");
    const now = clock.now();
    const [batch] = await tx
      .insert(contentImports)
      .values({
        companyId: input.companyId,
        requestId: input.requestId,
        payloadHash,
        fileName: input.fileName,
        fileSha256: sha(input.text),
        format: input.format,
        importedCount: preview.newCount,
        skippedCount: preview.skippedCount,
        entryIds: [],
        createdBy: actor.userId,
        createdAt: now,
      })
      .returning();
    const entryIds: string[] = [];
    for (const row of preview.rows) {
      if (row.status !== "new") continue;
      const a = row.article;
      const [entry] = await tx
        .insert(contentEntries)
        .values({
          companyId: input.companyId,
          slug: a.slug,
          sourceUrl: a.sourceUrl,
          originalPublishedAt: a.originalPublishedAt ? new Date(a.originalPublishedAt) : null,
          importId: batch!.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await tx.insert(contentRevisions).values({
        entryId: entry!.id,
        revision: 1,
        title: a.title,
        body: a.body,
        images: a.images ?? [],
        category: a.category,
        createdBy: actor.userId,
        createdAt: now,
      });
      entryIds.push(entry!.id);
    }
    await tx.update(contentImports).set({ entryIds }).where(eq(contentImports.id, batch!.id));
    await recordEvent(tx, clock, {
      actor,
      action: "content.import",
      targetType: "content_import",
      targetId: batch!.id,
      after: {
        companyId: input.companyId,
        importedCount: entryIds.length,
        skippedCount: preview.skippedCount,
        fileSha256: sha(input.text),
      },
    });
    return ok({
      id: batch!.id,
      importedCount: entryIds.length,
      skippedCount: preview.skippedCount,
      alreadyRecorded: false,
    });
  });
}
