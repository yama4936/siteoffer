import { type DbOrTx, deliveries, deliveryVersions, shareLinks, users } from "@siteoffer/db";
import { and, count, desc, eq } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { err, ok } from "../common/result.ts";
import { recoverShareLink, revokeShareLink } from "../share-link/share-link.ts";
import type { ShareTokenRecovery } from "../share-link/token.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function activeOps(db: DbOrTx, actor: Actor | null) {
  if (actor?.kind !== "ops" || !uuid.test(actor.userId)) return false;
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  return !!u;
}
/** トークンを含まない発行履歴。過去の版も取り消せるが、再表示は現在の顧客確認中の版だけ。 */
export async function listCustomerReviewLinks(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  deliveryId: string,
  requestedPage = 1,
) {
  if (!(await activeOps(db, actor))) return err("forbidden" as const);
  if (!uuid.test(deliveryId)) return err("not_found" as const);
  const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  if (!delivery) return err("not_found" as const);
  const where = and(eq(deliveryVersions.deliveryId, deliveryId), eq(shareLinks.purpose, "delivery"));
  const [n] = await db
    .select({ total: count() })
    .from(shareLinks)
    .innerJoin(deliveryVersions, eq(deliveryVersions.id, shareLinks.targetId))
    .where(where);
  const total = n?.total ?? 0,
    pages = Math.max(1, Math.ceil(total / 20)),
    page = Math.min(pages, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const rows = await db
    .select({
      id: shareLinks.id,
      versionId: deliveryVersions.id,
      version: deliveryVersions.version,
      createdBy: shareLinks.createdBy,
      creator: users.displayName,
      createdAt: shareLinks.createdAt,
      expiresAt: shareLinks.expiresAt,
      revokedAt: shareLinks.revokedAt,
      recoveryKeyId: shareLinks.recoveryKeyId,
    })
    .from(shareLinks)
    .innerJoin(deliveryVersions, eq(deliveryVersions.id, shareLinks.targetId))
    .innerJoin(users, eq(users.id, shareLinks.createdBy))
    .where(where)
    .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id))
    .limit(20)
    .offset((page - 1) * 20);
  return ok({
    total,
    page,
    pages,
    links: rows.map(({ recoveryKeyId, createdBy, revokedAt, ...r }) => ({
      ...r,
      own: actor?.kind === "ops" && createdBy === actor.userId,
      recoverable: !!recoveryKeyId,
      state: revokedAt
        ? ("revoked" as const)
        : r.expiresAt <= clock.now()
          ? ("expired" as const)
          : delivery.status !== "customer_review" ||
              delivery.reviewVersionId !== r.versionId ||
              delivery.lockedVersionId
            ? ("closed" as const)
            : ("active" as const),
    })),
  });
}
async function lockedLink(db: DbOrTx, deliveryId: string, linkId: string) {
  if (!uuid.test(deliveryId) || !uuid.test(linkId)) return null;
  const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId)).for("update");
  if (!delivery) return null;
  const [link] = await db
    .select({ id: shareLinks.id, targetId: shareLinks.targetId })
    .from(shareLinks)
    .innerJoin(deliveryVersions, eq(deliveryVersions.id, shareLinks.targetId))
    .where(
      and(eq(shareLinks.id, linkId), eq(shareLinks.purpose, "delivery"), eq(deliveryVersions.deliveryId, deliveryId)),
    );
  return link ? { delivery, link } : null;
}
export async function recoverCustomerReviewLink(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  deliveryId: string,
  linkId: string,
  recovery?: ShareTokenRecovery,
) {
  return db.transaction(async (tx) => {
    if (!(await activeOps(tx, actor))) return err("forbidden" as const);
    const found = await lockedLink(tx, deliveryId, linkId);
    if (!found) return err("not_found" as const);
    const { delivery, link } = found;
    if (delivery.status !== "customer_review" || delivery.reviewVersionId !== link.targetId || delivery.lockedVersionId)
      return err("not_under_review" as const);
    return recoverShareLink(tx, clock, actor, linkId, recovery);
  });
}
/** 運営は他の運営が発行したリンクも取り消せる。同じ取り消しの再送は成功として返す。 */
export async function revokeCustomerReviewLink(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  deliveryId: string,
  linkId: string,
) {
  return db.transaction(async (tx) => {
    if (!(await activeOps(tx, actor))) return err("forbidden" as const);
    if (!(await lockedLink(tx, deliveryId, linkId))) return err("not_found" as const);
    const r = await revokeShareLink(tx, clock, actor, linkId);
    return r.ok || r.error === "already_revoked" ? ok({ revoked: true }) : r;
  });
}
