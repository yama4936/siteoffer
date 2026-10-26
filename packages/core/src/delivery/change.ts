import { createHash } from "node:crypto";
import {
  approvals,
  contracts,
  type DbOrTx,
  deliveries,
  deliveryBuilds,
  deliveryChanges,
  deliveryVersions,
  shareLinks,
  users,
} from "@siteoffer/db";
import { deliveryChangeInputSchema } from "@siteoffer/schemas";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok } from "../common/result.ts";
import { findSecretInFields } from "../domain-preference/secrets.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 承認・公開履歴を保持したまま、新しい顧客確認が必要な変更受付を作る。 */
export async function requestDeliveryChange(db: DbOrTx, clock: Clock, actor: Actor | null, raw: unknown) {
  if (actor?.kind !== "ops" || !uuid.test(actor.userId)) return err("forbidden");
  const parsed = deliveryChangeInputSchema.safeParse(raw);
  if (!parsed.success) return err("invalid_input", "変更理由・変更内容・確認チェックを入力してください");
  const input = parsed.data;
  if (findSecretInFields({ reason: input.reason, requestedChanges: input.requestedChanges }))
    return err("secret_like_value", "パスワード・移管コードなどの秘密情報は記入しないでください");
  const payloadHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(deliveries).where(eq(deliveries.id, input.deliveryId)).for("update");
    if (!d) return err("not_found");
    const [u] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")))
      .for("share");
    if (!u) return err("forbidden");
    const [receipt] = await tx.select().from(deliveryChanges).where(eq(deliveryChanges.requestId, input.requestId));
    if (receipt)
      return receipt.deliveryId === d.id && receipt.requestedBy === actor.userId && receipt.payloadHash === payloadHash
        ? ok({ id: receipt.id, alreadyRecorded: true })
        : err("request_conflict", "受付番号と内容が一致しません。最新の画面を確認してください");
    if (d.status !== input.expectedStatus || d.lockedVersionId !== input.fromVersionId)
      return err("conflict", "承認版または制作状態が更新されています。入力を控えて最新の状態を確認してください");
    const [contract] = await tx
      .select({ status: contracts.status })
      .from(contracts)
      .where(eq(contracts.id, d.contractId));
    if (contract?.status !== "completed") return err("invalid_state", "完了した契約だけを変更できます");
    const [version] = await tx
      .select()
      .from(deliveryVersions)
      .where(and(eq(deliveryVersions.id, input.fromVersionId), eq(deliveryVersions.deliveryId, d.id)));
    const [approval] = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.deliveryVersionId, input.fromVersionId), eq(approvals.decision, "approved")))
      .limit(1);
    if (!version || !approval) return err("invalid_state", "以前の承認記録を確認できません");
    const [open] = await tx
      .select({ id: deliveryChanges.id })
      .from(deliveryChanges)
      .where(and(eq(deliveryChanges.deliveryId, d.id), isNull(deliveryChanges.approvedVersionId)));
    if (open) return err("conflict", "この納品は既に変更対応中です");
    const now = clock.now();
    const [saved] = await tx
      .insert(deliveryChanges)
      .values({
        deliveryId: d.id,
        fromVersionId: version.id,
        fromBuildId: d.currentBuildId,
        priorStatus: d.status,
        requestId: input.requestId,
        payloadHash,
        reason: input.reason,
        requestedChanges: input.requestedChanges,
        requestedBy: actor.userId,
        createdAt: now,
      })
      .returning();
    const targets = tx
      .select({ id: deliveryVersions.id })
      .from(deliveryVersions)
      .where(eq(deliveryVersions.deliveryId, d.id));
    const revoked = await tx
      .update(shareLinks)
      .set({ revokedAt: now })
      .where(
        and(eq(shareLinks.purpose, "delivery"), inArray(shareLinks.targetId, targets), isNull(shareLinks.revokedAt)),
      )
      .returning({ id: shareLinks.id });
    if (d.currentBuildId)
      await tx
        .update(deliveryBuilds)
        .set({ status: "cancelled", leaseUntil: null, finishedAt: now })
        .where(
          and(
            eq(deliveryBuilds.id, d.currentBuildId),
            eq(deliveryBuilds.deliveryId, d.id),
            inArray(deliveryBuilds.status, ["queued", "running"]),
          ),
        );
    await tx
      .update(deliveries)
      .set({
        status: "info_gathering",
        lockedVersionId: null,
        reviewVersionId: null,
        currentBuildId: null,
        updatedAt: now,
      })
      .where(eq(deliveries.id, d.id));
    await recordEvent(tx, clock, {
      actor,
      action: "delivery.change_request",
      targetType: "delivery",
      targetId: d.id,
      before: { status: d.status, lockedVersionId: d.lockedVersionId, currentBuildId: d.currentBuildId },
      after: {
        status: "info_gathering",
        changeId: saved!.id,
        fromVersionId: version.id,
        revokedLinkIds: revoked.map((x) => x.id),
      },
    });
    return ok({ id: saved!.id, alreadyRecorded: false });
  });
}
/** 変更受付前の版は再共有しない。最新の変更受付に属する制作回だけを共有する。 */
export async function deliveryVersionSuperseded(db: DbOrTx, versionId: string) {
  const [v] = await db
    .select({ deliveryId: deliveryVersions.deliveryId, buildId: deliveryVersions.buildId })
    .from(deliveryVersions)
    .where(eq(deliveryVersions.id, versionId));
  if (!v) return true;
  const [change] = await db
    .select({ id: deliveryChanges.id })
    .from(deliveryChanges)
    .innerJoin(deliveryVersions, eq(deliveryVersions.id, deliveryChanges.fromVersionId))
    .where(eq(deliveryChanges.deliveryId, v.deliveryId))
    .orderBy(desc(deliveryVersions.version))
    .limit(1);
  if (!change) return false;
  if (!v.buildId) return true;
  const [build] = await db
    .select({ changeId: deliveryBuilds.changeId })
    .from(deliveryBuilds)
    .where(and(eq(deliveryBuilds.id, v.buildId), eq(deliveryBuilds.deliveryId, v.deliveryId)));
  return build?.changeId !== change.id;
}
