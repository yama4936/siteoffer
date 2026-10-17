import { randomUUID } from "node:crypto";
import {
  claimDeliveryBuild,
  completeDeliveryBuild,
  createDeliveryForContract,
  failDeliveryBuild,
  fixedClock,
  retryDeliveryBuild,
  transitionDelivery,
} from "@siteoffer/core";
import { seedDeliveryBase } from "@siteoffer/core/delivery/testing";
import { companies, contracts, type Db, deliveries, deliveryBuilds, generationJobs, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getProcessingOverview } from "./processing";
import { emptyWorkFilters } from "./work-filters";
import { getOpsWorkPage } from "./work-page";
import { getOpsWorkQueue } from "./work-queue";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-16T00:00:00Z");
const worker = { kind: "system" as const, job: "work-queue-test" };
function must<T extends { ok: true; value: unknown } | { ok: false; error: string }>(
  r: T,
): Extract<T, { ok: true }>["value"] {
  if (!r.ok) throw Error(r.error);
  return r.value as Extract<T, { ok: true }>["value"];
}
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock.set("2026-10-16T00:00:00Z");
});
afterEach(async () => {
  await close();
});
async function seed() {
  const b = await seedDeliveryBase(db);
  await db.update(companies).set({ officialSiteStatus: "confirmed" }).where(eq(companies.id, b.company.id));
  const { delivery } = must(await createDeliveryForContract(db, clock, b.ops, b.contract.id));
  const d = must(await transitionDelivery(db, clock, b.ops, delivery.id, "building"));
  return { ...b, d };
}
it("停止から再試行・完了まで現在の制作回だけを集め、閲覧では状態を変更しない", async () => {
  const b = await seed(),
    ownerId = randomUUID();
  const claim = { deliveryId: b.d.id, buildId: b.d.currentBuildId!, ownerId };
  const pending = must(await getProcessingOverview(db, clock, b.ops));
  expect(pending.deliveries).toMatchObject([{ id: b.d.id, state: "queued" }]);
  expect(must(await getOpsWorkQueue(db, b.ops, clock)).items).toEqual([]);
  must(await claimDeliveryBuild(db, clock, worker, b.d.id, ownerId));
  expect(must(await getProcessingOverview(db, clock, b.ops)).deliveries[0]?.state).toBe("running");
  await failDeliveryBuild(db, clock, worker, claim, "private-error-with-artifact-path");
  const q = must(await getOpsWorkQueue(db, b.ops, clock));
  expect(q.items).toMatchObject([
    { id: b.d.id, group: "delivery_recovery", priority: 0, href: `/ops/delivery?focus=${b.d.id}#delivery-${b.d.id}` },
  ]);
  expect(JSON.stringify(q)).not.toContain("private-error");
  expect(must(await getProcessingOverview(db, clock, b.ops, b.company.id, {}, "stopped")).deliveries).toMatchObject([
    { state: "failed" },
  ]);
  const next = must(await retryDeliveryBuild(db, clock, b.ops, b.d.id, claim.buildId));
  expect(must(await getOpsWorkQueue(db, b.ops, clock)).items).toEqual([]);
  expect(must(await getProcessingOverview(db, clock, b.ops, undefined, {}, "stopped")).deliveries).toEqual([]);
  const nextClaim = { ...claim, buildId: next.buildId, ownerId: randomUUID() };
  must(await claimDeliveryBuild(db, clock, worker, b.d.id, nextClaim.ownerId));
  clock.advance(5000);
  await db.update(deliveryBuilds).set({ leaseUntil: clock.now() }).where(eq(deliveryBuilds.id, next.buildId));
  expect(must(await getOpsWorkQueue(db, b.ops, clock)).items[0]?.reason).toContain("接続が途切れました");
  expect(must(await getProcessingOverview(db, clock, b.ops)).deliveries[0]?.state).toBe("interrupted");
  expect(must(await getProcessingOverview(db, clock, b.ops)).deliveries[0]?.since).toEqual(clock.now());
  expect((await db.select().from(deliveryBuilds).where(eq(deliveryBuilds.id, next.buildId)))[0]?.status).toBe(
    "running",
  );
  const last = must(await retryDeliveryBuild(db, clock, b.ops, b.d.id, next.buildId));
  const finalClaim = { ...claim, buildId: last.buildId, ownerId: randomUUID() };
  must(await claimDeliveryBuild(db, clock, worker, b.d.id, finalClaim.ownerId));
  const [job] = await db
    .insert(generationJobs)
    .values({
      companyId: b.company.id,
      purpose: "delivery_site",
      status: "succeeded",
      generator: "mock",
      promptVersion: "test",
      idempotencyKey: randomUUID(),
    })
    .returning();
  must(
    await completeDeliveryBuild(db, clock, worker, finalClaim, { generationJobId: job!.id, artifactDir: "/fixture" }),
  );
  expect(must(await getProcessingOverview(db, clock, b.ops)).deliveries).toEqual([]);
  expect(must(await getOpsWorkQueue(db, b.ops, clock)).items).toMatchObject([{ group: "delivery", priority: 2 }]);
});
it("停止案件の全件数とページ送り、企業絞り込みを保ち、正常実行と旧データを区別する", async () => {
  const rows = [];
  for (let i = 0; i < 25; i++) {
    const b = await seed();
    rows.push(b);
    await db
      .update(deliveryBuilds)
      .set({ status: "failed", error: "private-error", finishedAt: clock.now() })
      .where(eq(deliveryBuilds.id, b.d.currentBuildId!));
    clock.advance(1000);
  }
  const b = rows[0]!;
  await db.update(companies).set({ suppression: "do_not_contact" }).where(eq(companies.id, b.company.id));
  const running = await seed();
  await db
    .update(deliveryBuilds)
    .set({ status: "running", leaseUntil: new Date(clock.now().getTime() + 120000) })
    .where(eq(deliveryBuilds.id, running.d.currentBuildId!));
  const legacy = await seed();
  await db.update(deliveries).set({ currentBuildId: null }).where(eq(deliveries.id, legacy.d.id));
  const q = must(await getOpsWorkQueue(db, b.ops, clock));
  expect(q.groups.find((g) => g.key === "delivery_recovery")?.count).toBe(25);
  expect(q.items).toHaveLength(20);
  expect(q.items[0]?.id).toBe(b.d.id);
  const all = must(await getProcessingOverview(db, clock, b.ops));
  expect(all.paging.deliveries).toEqual({ page: 1, pages: 2, total: 27 });
  const second = must(await getProcessingOverview(db, clock, b.ops, undefined, { deliveries: 999 }, "stopped"));
  expect(second.paging.deliveries).toEqual({ page: 2, pages: 2, total: 25 });
  expect(second.deliveries.map((d) => d.id)).toEqual(rows.slice(20).map((r) => r.d.id));
  const focused = must(await getProcessingOverview(db, clock, b.ops, b.company.id, { deliveries: 999 }, "stopped"));
  expect(focused.paging.deliveries).toEqual({ page: 1, pages: 1, total: 1 });
  expect(focused.deliveries[0]?.id).toBe(b.d.id);
  expect(must(await getProcessingOverview(db, clock, b.ops, running.company.id, {}, "stopped")).deliveries).toEqual([]);
  expect(must(await getProcessingOverview(db, clock, b.ops, legacy.company.id)).deliveries[0]?.state).toBe("queued");
  expect(JSON.stringify(second)).not.toContain("private-error");
  await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, b.contract.id));
  expect(must(await getOpsWorkQueue(db, b.ops, clock)).items.some((i) => i.id === b.d.id)).toBe(false);
  expect(must(await getProcessingOverview(db, clock, b.ops, b.company.id)).deliveries).toEqual([]);
});
it("別納品の制作回や無効な運営権限から停止情報を取得しない", async () => {
  const a = await seed(),
    b = await seed();
  await db.update(deliveryBuilds).set({ status: "failed" }).where(eq(deliveryBuilds.id, a.d.currentBuildId!));
  await db.update(deliveries).set({ currentBuildId: a.d.currentBuildId }).where(eq(deliveries.id, b.d.id));
  expect(must(await getOpsWorkQueue(db, b.ops, clock)).items.map((i) => i.id)).toEqual([a.d.id]);
  expect(must(await getProcessingOverview(db, clock, b.ops, b.company.id, {}, "stopped")).deliveries).toEqual([]);
  for (const actor of [
    null,
    b.sales,
    { kind: "ops" as const, userId: b.sales.userId },
    { kind: "ops" as const, userId: "invalid" },
  ]) {
    expect((await getOpsWorkQueue(db, actor, clock)).ok).toBe(false);
    expect((await getProcessingOverview(db, clock, actor)).ok).toBe(false);
  }
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, b.ops.userId));
  expect((await getOpsWorkQueue(db, b.ops, clock)).ok).toBe(false);
  expect((await getProcessingOverview(db, clock, b.ops)).ok).toBe(false);
});

it("1回の仕事の読み取りは期限判定の基準時刻も揃える", async () => {
  const b = await seed();
  must(await claimDeliveryBuild(db, clock, worker, b.d.id, randomUUID()));
  const started = clock.now().getTime();
  let calls = 0;
  const moving = { now: () => new Date(started + calls++ * 3600000) };
  const r = must(
    await getOpsWorkPage(db, b.ops, { ...emptyWorkFilters, group: "delivery_recovery", query: b.company.name }, moving),
  );
  expect(r.groups.find((g) => g.key === "delivery_recovery")?.count).toBe(0);
  expect(r.items).toEqual([]);
});
