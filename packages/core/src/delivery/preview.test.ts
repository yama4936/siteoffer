import { randomUUID } from "node:crypto";
import {
  approvals,
  auditEvents,
  type Db,
  deliveries,
  deliveryPreviews,
  deliveryVersions,
  sessions,
  shareLinks,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hashToken } from "../auth/crypto.ts";
import { fixedClock } from "../common/clock.ts";
import { verifyShareLink } from "../share-link/share-link.ts";
import { addDeliveryVersion, createDeliveryForContract, transitionDelivery } from "./delivery.ts";
import { DELIVERY_PREVIEW_TTL_MS, issueDeliveryPreview, verifyDeliveryPreview } from "./preview.ts";
import { seedDeliveryBase } from "./test-helpers.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-16T00:00:00Z");
function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw Error(r.error);
  return r.value;
}
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock.set("2026-10-16T00:00:00Z");
});
afterEach(async () => {
  await close();
});
async function seed() {
  const b = await seedDeliveryBase(db),
    token = randomUUID();
  const [session] = await db
    .insert(sessions)
    .values({ userId: b.ops.userId, tokenHash: hashToken(token), expiresAt: new Date(clock.now().getTime() + 3600000) })
    .returning();
  const { delivery } = must(await createDeliveryForContract(db, clock, b.ops, b.contract.id));
  must(await transitionDelivery(db, clock, b.ops, delivery.id, "building"));
  const v1 = must(await addDeliveryVersion(db, clock, b.ops, delivery.id, { artifactDir: "/fixture/first" }));
  const v2 = must(await addDeliveryVersion(db, clock, b.ops, delivery.id, { artifactDir: "/fixture/second" }));
  return { ...b, token, session: session!, delivery, v1, v2 };
}
it("指定した制作版だけを表示し、顧客確認・承認・共有リンク・操作履歴を変えない", async () => {
  const b = await seed(),
    before = await db.select().from(deliveries),
    events = await db.select().from(auditEvents);
  for (const v of [b.v1, b.v2]) {
    const grant = must(await issueDeliveryPreview(db, clock, b.ops, b.token, b.delivery.id, v.id));
    expect(must(await verifyDeliveryPreview(db, clock, grant.token)).artifactDir).toBe(v.artifactDir);
    expect(grant.expiresAt.getTime() - clock.now().getTime()).toBe(DELIVERY_PREVIEW_TTL_MS);
    expect(JSON.stringify(await db.select().from(deliveryPreviews))).not.toContain(grant.token);
    expect((await verifyShareLink(db, clock, grant.token)).ok).toBe(false);
  }
  expect(await db.select().from(deliveries)).toEqual(before);
  expect(await db.select().from(auditEvents)).toEqual(events);
  expect(await db.select().from(shareLinks)).toHaveLength(0);
  expect(await db.select().from(approvals)).toHaveLength(0);
});
it("未ログイン・営業・偽装した役割・別セッション・別納品の版を拒否する", async () => {
  const b = await seed(),
    other = await seed();
  for (const actor of [null, b.sales, { kind: "ops" as const, userId: b.sales.userId }, other.ops])
    expect(await issueDeliveryPreview(db, clock, actor, b.token, b.delivery.id, b.v1.id)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  expect((await issueDeliveryPreview(db, clock, b.ops, "wrong", b.delivery.id, b.v1.id)).ok).toBe(false);
  expect((await issueDeliveryPreview(db, clock, b.ops, b.token, other.delivery.id, b.v1.id)).ok).toBe(false);
  expect((await issueDeliveryPreview(db, clock, b.ops, b.token, b.delivery.id, "invalid")).ok).toBe(false);
  expect(await db.select().from(deliveryPreviews)).toHaveLength(0);
});
it("配信時に役割変更・利用停止・成果物の欠落を反映し、ログアウトで権限を削除する", async () => {
  const b = await seed(),
    grant = must(await issueDeliveryPreview(db, clock, b.ops, b.token, b.delivery.id, b.v1.id));
  for (const patch of [{ role: "sales" as const }, { role: "ops" as const, status: "suspended" as const }]) {
    await db.update(users).set(patch).where(eq(users.id, b.ops.userId));
    expect((await verifyDeliveryPreview(db, clock, grant.token)).ok).toBe(false);
    expect((await issueDeliveryPreview(db, clock, b.ops, b.token, b.delivery.id, b.v1.id)).ok).toBe(false);
  }
  await db.update(users).set({ role: "ops", status: "active" }).where(eq(users.id, b.ops.userId));
  await db.update(deliveryVersions).set({ artifactDir: null }).where(eq(deliveryVersions.id, b.v1.id));
  expect((await verifyDeliveryPreview(db, clock, grant.token)).ok).toBe(false);
  await db.update(deliveryVersions).set({ artifactDir: "/fixture/first" }).where(eq(deliveryVersions.id, b.v1.id));
  expect((await verifyDeliveryPreview(db, clock, grant.token)).ok).toBe(true);
  await db.delete(sessions).where(eq(sessions.id, b.session.id));
  expect((await verifyDeliveryPreview(db, clock, grant.token)).ok).toBe(false);
  expect(await db.select().from(deliveryPreviews)).toHaveLength(0);
});
it("表示期限・セッション期限の短い方で失効し、期限切れの一時権限を次回発行時に除去する", async () => {
  const b = await seed(),
    first = must(await issueDeliveryPreview(db, clock, b.ops, b.token, b.delivery.id, b.v1.id));
  clock.set(first.expiresAt);
  expect((await verifyDeliveryPreview(db, clock, first.token)).ok).toBe(false);
  const end = new Date(clock.now().getTime() + 1000);
  await db.update(sessions).set({ expiresAt: end }).where(eq(sessions.id, b.session.id));
  const second = must(await issueDeliveryPreview(db, clock, b.ops, b.token, b.delivery.id, b.v1.id));
  expect(second.expiresAt).toEqual(end);
  expect(await db.select().from(deliveryPreviews)).toHaveLength(1);
  clock.set(end);
  expect((await verifyDeliveryPreview(db, clock, second.token)).ok).toBe(false);
  expect((await issueDeliveryPreview(db, clock, b.ops, b.token, b.delivery.id, b.v1.id)).ok).toBe(false);
});
