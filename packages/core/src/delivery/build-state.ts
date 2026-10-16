import { type DbOrTx, deliveries, deliveryBuilds, deliveryPreparations } from "@siteoffer/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Clock } from "../common/clock.ts";
import { captureDeliveryImageAssets } from "../image-assets.ts";

/** 呼び出し側が納品行をロック・認可したトランザクション内でだけ使う。 */
export async function beginDeliveryBuild(tx: DbOrTx, clock: Clock, delivery: typeof deliveries.$inferSelect) {
  const now = clock.now();
  if (delivery.currentBuildId)
    await tx
      .update(deliveryBuilds)
      .set({ status: "cancelled", leaseUntil: null, finishedAt: now })
      .where(
        and(
          eq(deliveryBuilds.id, delivery.currentBuildId),
          eq(deliveryBuilds.deliveryId, delivery.id),
          inArray(deliveryBuilds.status, ["queued", "running"]),
        ),
      );
  const [preparation] = await tx
    .select({ id: deliveryPreparations.id })
    .from(deliveryPreparations)
    .where(eq(deliveryPreparations.deliveryId, delivery.id))
    .orderBy(desc(deliveryPreparations.revision))
    .limit(1);
  const [build] = await tx
    .insert(deliveryBuilds)
    .values({
      deliveryId: delivery.id,
      previousId: delivery.currentBuildId,
      preparationId: preparation?.id ?? null,
      imageAssetSnapshot: await captureDeliveryImageAssets(tx, delivery.contractId),
      createdAt: now,
    })
    .returning();
  await tx.update(deliveries).set({ currentBuildId: build!.id }).where(eq(deliveries.id, delivery.id));
  return build!;
}
