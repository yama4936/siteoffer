import { randomUUID } from "node:crypto";
import {
  auditEvents,
  type Db,
  deliveries,
  deliveryBuilds,
  deliveryVersions,
  generationJobs,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "../common/clock.ts";
import {
  claimDeliveryBuild,
  completeDeliveryBuild,
  DELIVERY_BUILD_LEASE_MS,
  failDeliveryBuild,
  renewDeliveryBuild,
  retryDeliveryBuild,
} from "./build.ts";
import { decideAsCustomer, getCustomerReview } from "./customer.ts";
import { addDeliveryVersion, createDeliveryForContract, sendToCustomerReview, transitionDelivery } from "./delivery.ts";
import { CUSTOMER_IMAGE_CONSENT, seedDeliveryBase } from "./test-helpers.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-16T00:00:00Z"),
  worker = { kind: "system" as const, job: "build-test" };
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
  const { delivery } = must(await createDeliveryForContract(db, clock, b.ops, b.contract.id));
  const d = must(await transitionDelivery(db, clock, b.ops, delivery.id, "building"));
  const [job] = await db
    .insert(generationJobs)
    .values({
      companyId: b.company.id,
      purpose: "delivery_site",
      status: "succeeded",
      generator: "mock",
      promptVersion: "fixture",
      idempotencyKey: randomUUID(),
    })
    .returning();
  return { ...b, delivery: d, input: { artifactDir: "/fixture/result", generationJobId: job!.id } };
}
async function own(b: Awaited<ReturnType<typeof seed>>) {
  const ownerId = randomUUID();
  const claimed = must(await claimDeliveryBuild(db, clock, worker, b.delivery.id, ownerId));
  expect(claimed.completed).toBe(false);
  return { deliveryId: b.delivery.id, buildId: claimed.build.id, ownerId };
}
it("同じ時刻の差し戻しを別の制作回にし、古い版・取り下げた確認リンクを再利用しない", async () => {
  const b = await seed(),
    first = must(await addDeliveryVersion(db, clock, b.ops, b.delivery.id, b.input));
  must(await transitionDelivery(db, clock, b.ops, b.delivery.id, "ops_review"));
  const sent = must(await sendToCustomerReview(db, clock, b.ops, b.delivery.id, { versionId: first.id }));
  const back = must(await transitionDelivery(db, clock, b.ops, b.delivery.id, "building"));
  expect(back.updatedAt).toEqual(b.delivery.updatedAt);
  expect(back.currentBuildId).not.toBe(b.delivery.currentBuildId);
  expect(await transitionDelivery(db, clock, b.ops, b.delivery.id, "ops_review")).toMatchObject({
    ok: false,
    error: "no_version",
  });
  const second = must(await addDeliveryVersion(db, clock, b.ops, b.delivery.id, b.input));
  must(await transitionDelivery(db, clock, b.ops, b.delivery.id, "ops_review"));
  expect(await sendToCustomerReview(db, clock, b.ops, b.delivery.id, { versionId: first.id })).toMatchObject({
    ok: false,
    error: "version_requires_revision",
  });
  must(await sendToCustomerReview(db, clock, b.ops, b.delivery.id, { versionId: second.id }));
  expect(must(await getCustomerReview(db, clock, sent.issued.token)).state).toBe("closed");
  expect(
    (
      await decideAsCustomer(db, clock, sent.issued.token, {
        versionId: first.id,
        decision: "approved",
        imageRightsConsent: CUSTOMER_IMAGE_CONSENT,
      })
    ).ok,
  ).toBe(false);
});
it("複数ワーカーの同時受付で1つだけ実行権限を持ち、別の所有者は延長できない", async () => {
  const b = await seed(),
    owners = Array.from({ length: 4 }, () => randomUUID());
  const results = await Promise.all(owners.map((owner) => claimDeliveryBuild(db, clock, worker, b.delivery.id, owner)));
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok && r.error === "busy")).toHaveLength(3);
  const claim = {
    deliveryId: b.delivery.id,
    buildId: b.delivery.currentBuildId!,
    ownerId: owners[results.findIndex((r) => r.ok)]!,
  };
  expect(await renewDeliveryBuild(db, clock, worker, { ...claim, ownerId: randomUUID() })).toBe(false);
  clock.advance(60000);
  expect(await renewDeliveryBuild(db, clock, worker, claim)).toBe(true);
  const [run] = await db.select().from(deliveryBuilds).where(eq(deliveryBuilds.id, claim.buildId));
  expect(run!.leaseUntil!.getTime() - clock.now().getTime()).toBe(DELIVERY_BUILD_LEASE_MS);
  expect((await addDeliveryVersion(db, clock, b.ops, b.delivery.id, b.input)).ok).toBe(false);
  expect((await transitionDelivery(db, clock, b.ops, b.delivery.id, "ops_review")).ok).toBe(false);
});
it("版追加・実行完了・運営確認を一括確定し、同じ完了の並行再送は1版に留まる", async () => {
  const b = await seed(),
    claim = await own(b);
  const results = await Promise.all([1, 2, 3].map(() => completeDeliveryBuild(db, clock, worker, claim, b.input)));
  expect(new Set(results.map((r) => must(r).id)).size).toBe(1);
  expect(await db.select().from(deliveryVersions)).toHaveLength(1);
  expect((await db.select().from(deliveries))[0]!.status).toBe("ops_review");
  expect((await db.select().from(deliveryBuilds))[0]!.status).toBe("succeeded");
  expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "delivery.version_add"))).toHaveLength(1);
  expect((await completeDeliveryBuild(db, clock, worker, claim, { ...b.input, artifactDir: "/different" })).ok).toBe(
    false,
  );
});
it("実行期限切れを停止として保存し、同一再試行は1回だけ、古い完了は新しい回へ混ざらない", async () => {
  const b = await seed(),
    old = await own(b);
  clock.advance(DELIVERY_BUILD_LEASE_MS + 1);
  expect(await renewDeliveryBuild(db, clock, worker, old)).toBe(false);
  expect(await claimDeliveryBuild(db, clock, worker, b.delivery.id, randomUUID())).toMatchObject({
    ok: false,
    error: "interrupted",
  });
  expect(await claimDeliveryBuild(db, clock, worker, b.delivery.id, randomUUID())).toMatchObject({
    ok: false,
    error: "settled",
  });
  const retries = await Promise.all([1, 2].map(() => retryDeliveryBuild(db, clock, b.ops, b.delivery.id, old.buildId)));
  expect(new Set(retries.map((r) => must(r).buildId)).size).toBe(1);
  expect(await db.select().from(deliveryBuilds)).toHaveLength(2);
  expect((await completeDeliveryBuild(db, clock, worker, old, b.input)).ok).toBe(false);
  const latest = await own(b);
  must(await completeDeliveryBuild(db, clock, worker, latest, b.input));
  expect((await db.select().from(deliveryVersions))[0]!.buildId).toBe(latest.buildId);
  expect(await failDeliveryBuild(db, clock, worker, old, "古い失敗")).toBe(false);
});
it("失敗は再起動相当の受付でも保持し、役割・利用状態と表示した回を照合する", async () => {
  const b = await seed(),
    claim = await own(b);
  expect(await failDeliveryBuild(db, clock, worker, claim, "生成の入力を確認してください")).toBe(true);
  expect(await claimDeliveryBuild(db, clock, worker, b.delivery.id, randomUUID())).toMatchObject({
    ok: false,
    error: "settled",
  });
  for (const actor of [null, worker, b.sales, { kind: "ops" as const, userId: b.sales.userId }])
    expect((await retryDeliveryBuild(db, clock, actor, b.delivery.id, claim.buildId)).ok).toBe(false);
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, b.ops.userId));
  expect((await retryDeliveryBuild(db, clock, b.ops, b.delivery.id, claim.buildId)).ok).toBe(false);
  await db.update(users).set({ status: "active" }).where(eq(users.id, b.ops.userId));
  expect((await retryDeliveryBuild(db, clock, b.ops, b.delivery.id, randomUUID())).ok).toBe(false);
  const next = must(await retryDeliveryBuild(db, clock, b.ops, b.delivery.id, claim.buildId));
  expect((await retryDeliveryBuild(db, clock, b.ops, b.delivery.id, next.buildId)).ok).toBe(false);
});
it("監査の失敗は版追加・状態更新をロールバックし、別企業の生成結果も確定しない", async () => {
  const b = await seed(),
    other = await seed(),
    claim = await own(b);
  expect((await completeDeliveryBuild(db, clock, worker, claim, other.input)).ok).toBe(false);
  await db.execute(
    sql`create function reject_build_audit() returns trigger language plpgsql as $$ begin raise exception 'fixture'; end $$`,
  );
  await db.execute(
    sql`create trigger reject_build before insert on audit_events for each row execute function reject_build_audit()`,
  );
  await expect(completeDeliveryBuild(db, clock, worker, claim, b.input)).rejects.toThrow();
  expect(await db.select().from(deliveryVersions)).toHaveLength(0);
  expect((await db.select().from(deliveries).where(eq(deliveries.id, b.delivery.id)))[0]!.status).toBe("building");
  expect((await db.select().from(deliveryBuilds).where(eq(deliveryBuilds.id, claim.buildId)))[0]!.status).toBe(
    "running",
  );
});
it("今回の制作回へ明示的に追加された手動版は生成せず運営確認へ移す", async () => {
  const b = await seed();
  const version = must(await addDeliveryVersion(db, clock, b.ops, b.delivery.id, b.input));
  expect(must(await claimDeliveryBuild(db, clock, worker, b.delivery.id, randomUUID())).completed).toBe(true);
  expect((await db.select().from(deliveryVersions))[0]!.id).toBe(version.id);
  expect((await db.select().from(deliveries))[0]!.status).toBe("ops_review");
});
