import { deliveries, deliveryBuilds } from "@siteoffer/db";
import { and, eq, isNull, lte, or } from "drizzle-orm";

// 履歴の失敗ではなく、当該納品の現在の制作回だけを参照する。
export const currentDeliveryBuild = and(
  eq(deliveryBuilds.id, deliveries.currentBuildId),
  eq(deliveryBuilds.deliveryId, deliveries.id),
);
export function deliveryNeedsAttention(now: Date) {
  return or(
    eq(deliveryBuilds.status, "failed"),
    and(
      eq(deliveryBuilds.status, "running"),
      or(isNull(deliveryBuilds.leaseUntil), lte(deliveryBuilds.leaseUntil, now)),
    ),
  );
}
export function deliveryProcessingState(status: string | null, leaseUntil: Date | null, now: Date) {
  if (status === "failed") return "failed" as const;
  if (status === "running") return !leaseUntil || leaseUntil <= now ? ("interrupted" as const) : ("running" as const);
  if (!status || status === "queued") return "queued" as const;
  return "unknown" as const;
}
