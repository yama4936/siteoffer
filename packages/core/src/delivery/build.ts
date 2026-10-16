import { type DbOrTx, deliveries, deliveryBuilds, deliveryVersions, users } from "@siteoffer/db";
import { and, desc, eq, gt } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok } from "../common/result.ts";
import { beginDeliveryBuild } from "./build-state.ts";
import { addDeliveryVersion, transitionDelivery } from "./delivery.ts";
import { loadDeliveryInputSource } from "./preparation.ts";

export const DELIVERY_BUILD_LEASE_MS = 120000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INTERRUPTED_BUILD_MESSAGE = "制作処理との接続が途切れました。ワーカーの稼働を確認して再試行してください。";
export type DeliveryBuildClaim = { deliveryId: string; buildId: string; ownerId: string };

/** 1つの制作回を1ワーカーに割り当てる。期限切れは自動で二重実行せず、失敗として復旧対象にする。 */
export async function claimDeliveryBuild(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  deliveryId: string,
  ownerId: string,
) {
  if (actor?.kind !== "system") return err("forbidden" as const);
  if (!uuid.test(deliveryId) || !uuid.test(ownerId)) return err("not_found" as const);
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(deliveries).where(eq(deliveries.id, deliveryId)).for("update");
    if (d?.status !== "building" || d.lockedVersionId) return err("stale_build" as const);
    let [build] = d.currentBuildId
      ? await tx
          .select()
          .from(deliveryBuilds)
          .where(and(eq(deliveryBuilds.id, d.currentBuildId), eq(deliveryBuilds.deliveryId, d.id)))
      : [];
    if (!build) build = await beginDeliveryBuild(tx, clock, d);
    const now = clock.now();
    if (build.status === "running") {
      if (build.leaseUntil && build.leaseUntil > now) return err("busy" as const);
      await tx
        .update(deliveryBuilds)
        .set({ status: "failed", error: INTERRUPTED_BUILD_MESSAGE, leaseUntil: null, finishedAt: now })
        .where(eq(deliveryBuilds.id, build.id));
      return err("interrupted" as const);
    }
    if (build.status !== "queued") return err("settled" as const);
    const [version] = await tx
      .select()
      .from(deliveryVersions)
      .where(and(eq(deliveryVersions.deliveryId, d.id), eq(deliveryVersions.buildId, build.id)))
      .orderBy(desc(deliveryVersions.version))
      .limit(1);
    if (version?.artifactDir) {
      const moved = await transitionDelivery(tx, clock, actor, d.id, "ops_review", "制作版を運営確認へ回した");
      if (!moved.ok) throw Error(moved.error);
      return ok({ completed: true as const, delivery: moved.value, build });
    }
    await tx
      .update(deliveryBuilds)
      .set({
        status: "running",
        ownerId,
        leaseUntil: new Date(now.getTime() + DELIVERY_BUILD_LEASE_MS),
        startedAt: now,
        error: null,
      })
      .where(eq(deliveryBuilds.id, build.id));
    return ok({ completed: false as const, delivery: { ...d, currentBuildId: build.id }, build });
  });
}

/** 実行中の回だけを延長する。期限を過ぎた所有者は復活させない。 */
export async function renewDeliveryBuild(db: DbOrTx, clock: Clock, actor: Actor | null, claim: DeliveryBuildClaim) {
  if (actor?.kind !== "system") return false;
  const rows = await db
    .update(deliveryBuilds)
    .set({ leaseUntil: new Date(clock.now().getTime() + DELIVERY_BUILD_LEASE_MS) })
    .where(
      and(
        eq(deliveryBuilds.id, claim.buildId),
        eq(deliveryBuilds.deliveryId, claim.deliveryId),
        eq(deliveryBuilds.ownerId, claim.ownerId),
        eq(deliveryBuilds.status, "running"),
        gt(deliveryBuilds.leaseUntil, clock.now()),
      ),
    )
    .returning({ id: deliveryBuilds.id });
  return rows.length === 1;
}

export async function failDeliveryBuild(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  claim: DeliveryBuildClaim,
  reason: string,
) {
  if (actor?.kind !== "system") return false;
  const rows = await db
    .update(deliveryBuilds)
    .set({ status: "failed", error: reason.slice(0, 1000), leaseUntil: null, finishedAt: clock.now() })
    .where(
      and(
        eq(deliveryBuilds.id, claim.buildId),
        eq(deliveryBuilds.deliveryId, claim.deliveryId),
        eq(deliveryBuilds.ownerId, claim.ownerId),
        eq(deliveryBuilds.status, "running"),
      ),
    )
    .returning({ id: deliveryBuilds.id });
  return rows.length === 1;
}

/** 版の追加・実行完了・運営確認への移行を一括確定する。古い所有者は確定できない。 */
export async function completeDeliveryBuild(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  claim: DeliveryBuildClaim,
  input: { artifactDir: string; generationJobId: string },
) {
  if (actor?.kind !== "system") return err("forbidden" as const);
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(deliveries).where(eq(deliveries.id, claim.deliveryId)).for("update");
    const [run] = await tx
      .select()
      .from(deliveryBuilds)
      .where(and(eq(deliveryBuilds.id, claim.buildId), eq(deliveryBuilds.deliveryId, claim.deliveryId)))
      .for("update");
    if (!d || d.currentBuildId !== claim.buildId || !run || run.ownerId !== claim.ownerId)
      return err("stale_build" as const);
    if (run.status === "succeeded") {
      const [version] = await tx.select().from(deliveryVersions).where(eq(deliveryVersions.buildId, run.id)).limit(1);
      return version && version.artifactDir === input.artifactDir && version.generationJobId === input.generationJobId
        ? ok(version)
        : err("stale_build" as const);
    }
    if (
      d.status !== "building" ||
      d.lockedVersionId ||
      run.status !== "running" ||
      !run.leaseUntil ||
      run.leaseUntil <= clock.now()
    )
      return err("stale_build" as const);
    const added = await addDeliveryVersion(tx, clock, actor, d.id, { ...input, buildClaim: claim });
    if (!added.ok) return added;
    await tx
      .update(deliveryBuilds)
      .set({ status: "succeeded", leaseUntil: null, finishedAt: clock.now() })
      .where(eq(deliveryBuilds.id, run.id));
    const moved = await transitionDelivery(
      tx,
      clock,
      actor,
      d.id,
      "ops_review",
      "制作・検査済みの新しい版を運営確認へ回した",
    );
    if (!moved.ok) throw Error(moved.error);
    return ok(added.value);
  });
}

/** 表示した失敗回だけを再試行。応答消失後の同じ再試行で新しい回を増やさない。 */
export async function retryDeliveryBuild(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  deliveryId: string,
  buildId: string,
) {
  if (actor?.kind !== "ops") return err("forbidden" as const);
  if (!uuid.test(deliveryId) || !uuid.test(buildId)) return err("not_found" as const);
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
    if (!user) return err("forbidden" as const);
    const [d] = await tx.select().from(deliveries).where(eq(deliveries.id, deliveryId)).for("update");
    if (!d?.currentBuildId || d.status !== "building" || d.lockedVersionId) return err("stale_build" as const);
    const [run] = await tx
      .select()
      .from(deliveryBuilds)
      .where(and(eq(deliveryBuilds.id, d.currentBuildId), eq(deliveryBuilds.deliveryId, d.id)))
      .for("update");
    if (!run) return err("not_found" as const);
    if (run.previousId === buildId) return ok({ buildId: run.id });
    if (run.id !== buildId) return err("stale_build" as const);
    const interrupted = run.status === "running" && (!run.leaseUntil || run.leaseUntil <= clock.now());
    if (run.status !== "failed" && !interrupted) return err("not_failed" as const);
    if (interrupted)
      await tx
        .update(deliveryBuilds)
        .set({ status: "failed", error: INTERRUPTED_BUILD_MESSAGE, leaseUntil: null, finishedAt: clock.now() })
        .where(eq(deliveryBuilds.id, run.id));
    const source = await loadDeliveryInputSource(tx, d.id);
    if (!source || source.blockers.length)
      return err("preparation_required", source?.blockers.join(" / ") ?? "制作情報を確認してください。");
    const next = await beginDeliveryBuild(tx, clock, d);
    await tx.update(deliveries).set({ updatedAt: clock.now() }).where(eq(deliveries.id, d.id));
    await recordEvent(tx, clock, {
      actor,
      action: "delivery.build_retry",
      targetType: "delivery",
      targetId: d.id,
      before: { buildId },
      after: { buildId: next.id },
    });
    return ok({ buildId: next.id });
  });
}
