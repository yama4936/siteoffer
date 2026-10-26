import { createHash } from "node:crypto";
import { type DbOrTx, deliveries, deliveryBuilds, deliveryPreparations, users } from "@siteoffer/db";
import { deliveryPreparationInputSchema } from "@siteoffer/schemas";
import { and, desc, eq } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok } from "../common/result.ts";
import { findSecretInFields } from "../domain-preference/secrets.ts";
import { hasProductionScope, loadDeliverySource } from "./source.ts";

/** 制作回を指定したら、その回に固定した補完版だけを使う。nullの旧制作回を最新版へ付け替えない。 */
export async function loadDeliveryInputSource(db: DbOrTx, deliveryId: string, buildId?: string) {
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  if (!d) return null;
  let preparation: typeof deliveryPreparations.$inferSelect | null = null;
  if (buildId) {
    const [build] = await db
      .select()
      .from(deliveryBuilds)
      .where(and(eq(deliveryBuilds.id, buildId), eq(deliveryBuilds.deliveryId, d.id)));
    if (!build) return null;
    if (build.preparationId) {
      const [p] = await db
        .select()
        .from(deliveryPreparations)
        .where(and(eq(deliveryPreparations.id, build.preparationId), eq(deliveryPreparations.deliveryId, d.id)));
      if (!p) return null;
      preparation = p;
    }
  } else
    preparation =
      (
        await db
          .select()
          .from(deliveryPreparations)
          .where(eq(deliveryPreparations.deliveryId, d.id))
          .orderBy(desc(deliveryPreparations.revision))
          .limit(1)
      )[0] ?? null;
  const base = await loadDeliverySource(db, d.contractId);
  if (!base) return null;
  const source = preparation ? await loadDeliverySource(db, d.contractId, preparation) : base;
  return source
    ? { ...source, preparation, missing: { proposal: base.proposalMissing, scope: base.scopeMissing } }
    : null;
}

/** 契約の不足情報を納品用の別記録として補う。価格・契約原本・既に確定した提供範囲は変更しない。 */
export async function saveDeliveryPreparation(db: DbOrTx, clock: Clock, actor: Actor | null, raw: unknown) {
  if (actor?.kind !== "ops") return err("forbidden");
  const parsed = deliveryPreparationInputSchema.safeParse(raw);
  if (!parsed.success) return err("invalid_input", "提案・制作範囲・確認理由と確認チェックを入力してください。");
  const input = parsed.data;
  if (findSecretInFields({ scope: input.scopeText, reason: input.reason }))
    return err("secret_like_value", "パスワード・移管コードなどの秘密情報は記録しないでください。");
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(deliveries).where(eq(deliveries.id, input.deliveryId)).for("update");
    if (!d) return err("not_found");
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")))
      .for("share");
    if (!user) return err("forbidden");
    const [receipt] = await tx
      .select()
      .from(deliveryPreparations)
      .where(eq(deliveryPreparations.requestId, input.requestId));
    if (receipt)
      return receipt.confirmedBy === actor.userId && receipt.deliveryId === d.id && receipt.payloadHash === hash
        ? ok(receipt)
        : err("request_conflict", "受付番号の内容が異なります。最新の画面を開き直してください。");
    const [build] = d.currentBuildId
      ? await tx.select().from(deliveryBuilds).where(eq(deliveryBuilds.id, d.currentBuildId))
      : [];
    if (
      d.lockedVersionId ||
      !(d.status === "info_gathering" || (d.status === "building" && build?.status === "failed"))
    )
      return err("invalid_state", "制作中・確認中の内容は変更できません。停止した制作の準備画面で確認してください。");
    const source = await loadDeliveryInputSource(tx, d.id);
    if (source?.contract.status !== "completed")
      return err("invalid_state", "完了した契約の制作情報だけ補完できます。");
    if ((source.preparation?.revision ?? 0) !== input.expectedRevision)
      return err("conflict", "別の担当が更新しました。入力を控えて最新の確認内容を開き直してください。");
    if (!source.missing.proposal && !source.missing.scope)
      return err("not_needed", "この契約の制作情報は記録済みです。契約内容はここでは変更できません。");
    if (!source.missing.proposal && input.proposalVersionId !== source.contract.proposalVersionId)
      return err("fixed_proposal", "契約に記録された提案版は変更できません。");
    const scope = source.missing.scope ? input.scopeText : source.scope?.scope;
    if (!hasProductionScope(scope)) return err("scope_required", "契約資料で確認した制作範囲を入力してください。");
    const checked = await loadDeliverySource(tx, d.contractId, { proposalVersionId: input.proposalVersionId, scope });
    if (!checked || checked.blockers.length)
      return err("not_ready", checked?.blockers.join(" / ") ?? "提案の内容を確認できません。");
    const [saved] = await tx
      .insert(deliveryPreparations)
      .values({
        deliveryId: d.id,
        revision: input.expectedRevision + 1,
        requestId: input.requestId,
        payloadHash: hash,
        proposalVersionId: input.proposalVersionId,
        scope: scope!,
        reason: input.reason,
        confirmedBy: actor.userId,
        createdAt: clock.now(),
      })
      .returning();
    await tx.update(deliveries).set({ updatedAt: clock.now() }).where(eq(deliveries.id, d.id));
    await recordEvent(tx, clock, {
      actor,
      action: "delivery.preparation_confirm",
      targetType: "delivery",
      targetId: d.id,
      after: {
        preparationId: saved!.id,
        revision: saved!.revision,
        proposalVersionId: saved!.proposalVersionId,
        scope: saved!.scope,
        reason: saved!.reason,
      },
    });
    return ok(saved!);
  });
}
