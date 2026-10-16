import { companies, contentEntries, contentRevisions, contracts, type DbOrTx, deliveries } from "@siteoffer/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { recordEvent } from "./common/events.ts";
import type { Actor, Clock } from "./common/index.ts";

export class ContentError extends Error {}
function operator(actor: Actor | null): asserts actor is Extract<Actor, { kind: "ops" }> {
  if (actor?.kind !== "ops") throw new ContentError("運営権限が必要です");
}
export type ArticleInput = {
  companyId: string;
  entryId?: string;
  expectedRevision?: number;
  slug: string;
  title: string;
  body: string;
  category: string;
};
export async function saveArticle(db: DbOrTx, clock: Clock, actor: Actor | null, input: ArticleInput) {
  operator(actor);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.slug))
    throw new ContentError("URL名は半角英数字とハイフンで80文字以内です");
  if (!input.title.trim() || input.title.length > 160 || !input.body.trim() || input.body.length > 30000)
    throw new ContentError("見出しは1〜160文字、本文は1〜30000文字で入力してください");
  if (!["news", "blog"].includes(input.category)) throw new ContentError("記事の種類が不正です");
  return db.transaction(async (tx) => {
    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .for("update");
    if (!company) throw new ContentError("企業がありません");
    let entry: typeof contentEntries.$inferSelect;
    let revision = 1;
    if (input.entryId) {
      const [before] = await tx
        .select()
        .from(contentEntries)
        .where(and(eq(contentEntries.id, input.entryId), eq(contentEntries.companyId, input.companyId)))
        .for("update");
      if (!before) throw new ContentError("記事がありません");
      if (before.currentRevision !== input.expectedRevision)
        throw new ContentError("別の担当者が更新しました。画面を更新して変更を確認してください");
      if (before.slug !== input.slug) throw new ContentError("作成済み記事のURL名は変更できません");
      revision = before.currentRevision + 1;
      [entry] = (await tx
        .update(contentEntries)
        .set({ currentRevision: revision, updatedAt: clock.now() })
        .where(eq(contentEntries.id, before.id))
        .returning()) as [typeof contentEntries.$inferSelect];
    } else {
      const [duplicate] = await tx
        .select({ id: contentEntries.id })
        .from(contentEntries)
        .where(and(eq(contentEntries.companyId, input.companyId), eq(contentEntries.slug, input.slug)));
      if (duplicate) throw new ContentError("同じURL名の記事があります。別の名前を指定してください");
      [entry] = (await tx
        .insert(contentEntries)
        .values({ companyId: input.companyId, slug: input.slug, updatedAt: clock.now(), createdAt: clock.now() })
        .returning()) as [typeof contentEntries.$inferSelect];
    }
    await tx.insert(contentRevisions).values({
      entryId: entry.id,
      revision,
      title: input.title.trim(),
      body: input.body.trim(),
      category: input.category,
      createdBy: actor.userId,
      createdAt: clock.now(),
    });
    await recordEvent(tx, clock, {
      actor,
      action: "content.save_draft",
      targetType: "content",
      targetId: entry.id,
      after: { revision, companyId: input.companyId },
    });
    return entry;
  });
}
/** Publishing and rollbacks only move a revision pointer. Draft edits never alter public content. */
export async function publishArticle(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: { entryId: string; revision: number | null; expectedRevision: number },
) {
  operator(actor);
  return db.transaction(async (tx) => {
    const [entry] = await tx.select().from(contentEntries).where(eq(contentEntries.id, input.entryId)).for("update");
    if (!entry) throw new ContentError("記事がありません");
    if (entry.currentRevision !== input.expectedRevision)
      throw new ContentError("記事が更新されています。画面を更新して確認してください");
    if (input.revision !== null) {
      const [r] = await tx
        .select({ id: contentRevisions.id })
        .from(contentRevisions)
        .where(and(eq(contentRevisions.entryId, entry.id), eq(contentRevisions.revision, input.revision)));
      if (!r) throw new ContentError("掲載する版がありません");
    }
    await tx
      .update(contentEntries)
      .set({
        publishedRevision: input.revision,
        publishedAt: input.revision === null ? null : clock.now(),
        updatedAt: clock.now(),
      })
      .where(eq(contentEntries.id, entry.id));
    await recordEvent(tx, clock, {
      actor,
      action: input.revision === null ? "content.unpublish" : "content.publish",
      targetType: "content",
      targetId: entry.id,
      before: { revision: entry.publishedRevision },
      after: { revision: input.revision },
    });
    return entry;
  });
}
export async function publishedArticles(db: DbOrTx, companyId: string) {
  return db
    .select({
      id: contentEntries.id,
      slug: contentEntries.slug,
      publishedAt: contentEntries.publishedAt,
      revision: contentRevisions.revision,
      title: contentRevisions.title,
      body: contentRevisions.body,
      category: contentRevisions.category,
    })
    .from(contentEntries)
    .innerJoin(
      contentRevisions,
      and(
        eq(contentRevisions.entryId, contentEntries.id),
        eq(contentRevisions.revision, contentEntries.publishedRevision),
      ),
    )
    .where(and(eq(contentEntries.companyId, companyId), isNotNull(contentEntries.publishedRevision)))
    .orderBy(desc(contentEntries.publishedAt))
    .limit(500);
}
export async function hasPublishedSite(db: DbOrTx, companyId: string) {
  const [row] = await db
    .select({ id: deliveries.id })
    .from(deliveries)
    .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
    .where(
      and(
        eq(contracts.companyId, companyId),
        eq(contracts.status, "completed"),
        inArray(deliveries.status, ["published", "delivered"]),
      ),
    )
    .limit(1);
  return !!row;
}
