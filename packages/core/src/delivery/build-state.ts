import { type DbOrTx, deliveries, deliveryBuilds } from "@siteoffer/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Clock } from "../common/clock.ts";

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
  const [build] = await tx
    .insert(deliveryBuilds)
    .values({ deliveryId: delivery.id, previousId: delivery.currentBuildId, createdAt: now })
    .returning();
  await tx.update(deliveries).set({ currentBuildId: build!.id }).where(eq(deliveries.id, delivery.id));
  return build!;
}
