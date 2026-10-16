import { attachImageAssetFile, fixedClock } from "@siteoffer/core";
import { seedDeliveryBase } from "@siteoffer/core/delivery/testing";
import { type Db, imageAssets, imageSubmissions, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { updateImageAssetPolicy } from "./commands";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
async function setup() {
  const b = await seedDeliveryBase(db);
  const rows = await db
    .insert(imageAssets)
    .values(
      ["first", "second"].map((label) => ({ companyId: b.company.id, label, sourceType: "customer_upload" as const })),
    )
    .returning();
  return {
    ...b,
    rows,
    input: {
      companyId: b.company.id,
      imageAssetId: rows[0]!.id,
      rightsStatus: "use_approved" as const,
      allowProduction: true,
      allowSalesDemo: false,
      placement: "hero" as const,
      expectedRevision: 0,
    },
  };
}
it("同じ配置先を選び直すと次回用の配置だけを置き換え、古い画面の上書きを止める", async () => {
  const s = await setup();
  expect((await updateImageAssetPolicy({ db, clock }, s.ops, s.input)).ok).toBe(true);
  expect(await updateImageAssetPolicy({ db, clock }, s.ops, { ...s.input, allowProduction: false })).toMatchObject({
    ok: false,
    error: "conflict",
  });
  expect((await updateImageAssetPolicy({ db, clock }, s.ops, { ...s.input, imageAssetId: s.rows[1]!.id })).ok).toBe(
    true,
  );
  const [old] = await db.select().from(imageAssets).where(eq(imageAssets.id, s.rows[0]!.id));
  expect(old).toMatchObject({ placement: "reference", allowProduction: true, policyRevision: 2 });
});
it("画像取込前の画面から許諾を戻せず、停止運営と不正配置を拒否する", async () => {
  const s = await setup();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUyNvCwMDAxMDAwMDAAAAOrgFGyLjQ8AAAAABJRU5ErkJggg==",
    "base64",
  );
  await attachImageAssetFile(db, clock, s.ops, {
    companyId: s.company.id,
    assetId: s.rows[0]!.id,
    png,
    width: 2,
    height: 2,
  });
  expect(await updateImageAssetPolicy({ db, clock }, s.ops, s.input)).toMatchObject({ ok: false, error: "conflict" });
  expect(
    await updateImageAssetPolicy({ db, clock }, s.ops, { ...s.input, placement: "other" as "hero" }),
  ).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  expect(await updateImageAssetPolicy({ db, clock }, s.ops, { ...s.input, expectedRevision: 1 })).toMatchObject({
    ok: false,
    error: "forbidden",
  });
});

it("顧客提出は確認待ち・取り下げ済みなら台帳から許可を迂回できず、承認後も用途を拡大できない", async () => {
  const s = await setup();
  await db.insert(imageSubmissions).values({
    assetId: s.rows[0]!.id,
    submittedBy: s.sales.userId,
    rightsBasis: "own_work",
    rightsNote: "権利の説明テスト",
    requestedDemo: false,
    requestedProduction: true,
    updatedAt: clock.now(),
  });
  expect(await updateImageAssetPolicy({ db, clock }, s.ops, s.input)).toMatchObject({
    ok: false,
    error: "customer_scope",
  });
  await db.update(imageSubmissions).set({ status: "accepted" }).where(eq(imageSubmissions.assetId, s.rows[0]!.id));
  expect(await updateImageAssetPolicy({ db, clock }, s.ops, { ...s.input, allowSalesDemo: true })).toMatchObject({
    ok: false,
    error: "customer_scope",
  });
  expect((await updateImageAssetPolicy({ db, clock }, s.ops, s.input)).ok).toBe(true);
  await db.update(imageSubmissions).set({ status: "withdrawn" }).where(eq(imageSubmissions.assetId, s.rows[0]!.id));
  expect(await updateImageAssetPolicy({ db, clock }, s.ops, { ...s.input, expectedRevision: 1 })).toMatchObject({
    ok: false,
    error: "customer_scope",
  });
});
