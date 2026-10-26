import { type DbOrTx, deliveryPreviews, deliveryVersions, sessions, users } from "@siteoffer/db";
import { and, eq, gt, lte } from "drizzle-orm";
import { hashToken } from "../auth/crypto.ts";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { err, ok } from "../common/result.ts";
import { generateShareToken, hashShareToken, isShareTokenFormat } from "../share-link/token.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DELIVERY_PREVIEW_TTL_MS = 10 * 60 * 1000;

/** Cookieのセッション値はサーバー内だけで渡す。画面操作は顧客確認の状態を一切変更しない。 */
export async function issueDeliveryPreview(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  sessionToken: string,
  deliveryId: string,
  versionId: string,
) {
  if (actor?.kind !== "ops" || !sessionToken) return err("forbidden" as const);
  if (
    typeof deliveryId !== "string" ||
    typeof versionId !== "string" ||
    !uuid.test(deliveryId) ||
    !uuid.test(versionId)
  )
    return err("not_found" as const);
  return db.transaction(async (tx) => {
    const now = clock.now();
    const [session] = await tx
      .select({ id: sessions.id, expiresAt: sessions.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, hashToken(sessionToken)),
          eq(sessions.userId, actor.userId),
          eq(users.role, "ops"),
          eq(users.status, "active"),
          gt(sessions.expiresAt, now),
        ),
      )
      .for("update", { of: sessions });
    if (!session) return err("forbidden" as const);
    const [v] = await tx
      .select()
      .from(deliveryVersions)
      .where(and(eq(deliveryVersions.id, versionId), eq(deliveryVersions.deliveryId, deliveryId)));
    if (!v?.artifactDir) return err("not_found" as const);
    const expiresAt = new Date(Math.min(session.expiresAt.getTime(), now.getTime() + DELIVERY_PREVIEW_TTL_MS));
    const token = generateShareToken();
    // 期限切れの一時権限だけを削除。顧客の共有リンクや操作履歴は触らない。
    await tx.delete(deliveryPreviews).where(lte(deliveryPreviews.expiresAt, now));
    await tx
      .insert(deliveryPreviews)
      .values({ sessionId: session.id, versionId, tokenHash: hashShareToken(token), expiresAt, createdAt: now });
    return ok({ token, expiresAt });
  });
}

/** 配信ファイルごとにログインの有効性・現在の役割と利用状態・版の存在を再確認する。 */
export async function verifyDeliveryPreview(db: DbOrTx, clock: Clock, token: string) {
  if (!isShareTokenFormat(token)) return err("not_found" as const);
  const now = clock.now();
  const [row] = await db
    .select({ id: deliveryPreviews.id, artifactDir: deliveryVersions.artifactDir })
    .from(deliveryPreviews)
    .innerJoin(sessions, eq(sessions.id, deliveryPreviews.sessionId))
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(deliveryVersions, eq(deliveryVersions.id, deliveryPreviews.versionId))
    .where(
      and(
        eq(deliveryPreviews.tokenHash, hashShareToken(token)),
        gt(deliveryPreviews.expiresAt, now),
        gt(sessions.expiresAt, now),
        eq(users.role, "ops"),
        eq(users.status, "active"),
      ),
    );
  if (!row?.artifactDir) return err("not_found" as const);
  return ok({ linkId: row.id, artifactDir: row.artifactDir, purpose: "internal_delivery" as const });
}
