import { randomUUID } from "node:crypto";
import { auditEvents, type Db, deliveryBuilds, imageAssetFiles, imageAssets, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { imagePolicySchema } from "@siteoffer/schemas";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import { decideAsCustomer } from "./delivery/customer.ts";
import {
  addDeliveryVersion,
  createDeliveryForContract,
  recordPublication,
  sendToCustomerReview,
  transitionDelivery,
} from "./delivery/delivery.ts";
import { CUSTOMER_IMAGE_CONSENT, seedDeliveryBase } from "./delivery/test-helpers.ts";
import {
  attachImageAssetFile,
  CUSTOMER_CONSENT_CONFIRMER,
  type DeliveryImageAsset,
  deliveryImageAssetsValid,
  getImageAssetFile,
  loadDeliveryImageAssets,
} from "./image-assets.ts";
import { verifyShareLink } from "./share-link/share-link.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUyNvCwMDAxMDAwMDAAAAOrgFGyLjQ8AAAAABJRU5ErkJggg==",
  "base64",
);
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw Error(r.error);
  return r.value;
}
async function fixture() {
  const b = await seedDeliveryBase(db);
  const [a] = await db
    .insert(imageAssets)
    .values({
      companyId: b.company.id,
      label: "顧客のロゴ",
      sourceType: "customer_upload",
      placement: "logo",
      rightsStatus: "use_approved",
      allowProduction: true,
      confirmedBy: b.ops.userId,
      confirmedAt: clock.now(),
    })
    .returning();
  const input = { companyId: b.company.id, assetId: a!.id, png, width: 2, height: 2 };
  return { ...b, a: a!, input };
}
async function allow(s: Awaited<ReturnType<typeof fixture>>) {
  await db
    .update(imageAssets)
    .set({ rightsStatus: "use_approved", allowProduction: true, confirmedBy: s.ops.userId, confirmedAt: clock.now() })
    .where(eq(imageAssets.id, s.a.id));
}
async function start(s: Awaited<ReturnType<typeof fixture>>) {
  const { delivery } = must(await createDeliveryForContract(db, clock, s.ops, s.contract.id));
  return must(await transitionDelivery(db, clock, s.ops, delivery.id, "building"));
}
it("ファイルを固定し、初回取込だけ許諾を未確認に戻す。同じ画像の再送は確認結果を消さない", async () => {
  const s = await fixture();
  const r = await attachImageAssetFile(db, clock, s.ops, s.input);
  expect((await db.select().from(imageAssets))[0]).toMatchObject({
    rightsStatus: "unknown",
    allowProduction: false,
    confirmedBy: null,
    policyRevision: 1,
  });
  await allow(s);
  expect(await attachImageAssetFile(db, clock, s.ops, s.input)).toEqual({ ...r, alreadyStored: true });
  expect((await db.select().from(imageAssets))[0]!.allowProduction).toBe(true);
  const changed = Buffer.concat([png, Buffer.from("different")]);
  await expect(attachImageAssetFile(db, clock, s.ops, { ...s.input, png: changed })).rejects.toThrow("差し替え");
  expect(await db.select().from(imageAssetFiles)).toHaveLength(1);
  expect((await getImageAssetFile(db, s.ops, s.a.id))!.bytes).toEqual(png);
  expect((await db.select().from(auditEvents)).filter((e) => e.action === "image_asset.file_attach")).toHaveLength(1);
});
it("営業・停止運営・別企業・壊れた形式からの取込を拒否する", async () => {
  const s = await fixture();
  await expect(attachImageAssetFile(db, clock, s.sales, s.input)).rejects.toThrow("運営");
  await expect(attachImageAssetFile(db, clock, s.ops, { ...s.input, companyId: randomUUID() })).rejects.toThrow(
    "見つかりません",
  );
  await expect(attachImageAssetFile(db, clock, s.ops, { ...s.input, png: Buffer.from("<svg/>") })).rejects.toThrow(
    "形式",
  );
  await expect(attachImageAssetFile(db, clock, s.ops, { ...s.input, width: 3 })).rejects.toThrow("形式");
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  await expect(attachImageAssetFile(db, clock, s.ops, s.input)).rejects.toThrow("運営");
  await expect(getImageAssetFile(db, s.ops, s.a.id)).rejects.toThrow("運営");
  expect(await db.select().from(imageAssetFiles)).toEqual([]);
});
it("ファイル保存と許諾リセット・監査を一括確定する", async () => {
  const s = await fixture();
  await db.execute(
    sql`create function fail_asset() returns trigger language plpgsql as $$ begin raise exception 'fixture failure'; end $$`,
  );
  await db.execute(
    sql`create trigger fail_asset before insert on audit_events for each row execute function fail_asset()`,
  );
  await expect(attachImageAssetFile(db, clock, s.ops, s.input)).rejects.toThrow();
  expect(await db.select().from(imageAssetFiles)).toEqual([]);
  expect((await db.select().from(imageAssets))[0]!.allowProduction).toBe(true);
});
it("未取込・配置しない素材は納品へ渡さず、運営の許諾がなくてもファイルと配置がある素材は使う", async () => {
  for (const kind of ["missing", "reference", "unknown"]) {
    const s = await fixture();
    if (kind !== "missing") await attachImageAssetFile(db, clock, s.ops, s.input);
    if (kind === "reference")
      await db.update(imageAssets).set({ placement: "reference" }).where(eq(imageAssets.id, s.a.id));
    const d = await start(s);
    const files = await loadDeliveryImageAssets(db, d.currentBuildId!, d.id);
    if (kind !== "unknown") expect(files).toEqual([]);
    else {
      // 取込直後は運営の許諾が未確認（unknown）でも、権利は納品承認時の顧客同意で確定する
      expect((await db.select().from(imageAssets).where(eq(imageAssets.id, s.a.id)))[0]!.rightsStatus).toBe("unknown");
      expect(files).toHaveLength(1);
      expect(files[0]!.policy).toMatchObject({
        rightsStatus: "customer_claimed",
        allowedUses: ["production"],
        confirmedBy: CUSTOMER_CONSENT_CONFIRMER,
      });
      expect(imagePolicySchema.safeParse(files[0]!.policy).success).toBe(true);
    }
  }
});
it("制作開始時の画像と配置を固定し、後から追加・配置変更した素材は混ぜない", async () => {
  const s = await fixture();
  await attachImageAssetFile(db, clock, s.ops, s.input);
  await allow(s);
  const d = await start(s);
  await db.update(imageAssets).set({ placement: "reference" }).where(eq(imageAssets.id, s.a.id));
  const files = await loadDeliveryImageAssets(db, d.currentBuildId!, d.id);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ assetId: s.a.id, slot: "logo", bytes: png });
  await db.update(deliveryBuilds).set({ imageAssetSnapshot: null }).where(eq(deliveryBuilds.id, d.currentBuildId!));
  expect(await loadDeliveryImageAssets(db, d.currentBuildId!, d.id)).toEqual([]);
});
it("運営の許諾の変更では止めず、ファイルの変更を制作完了・共有・顧客承認・公開記録に反映する", async () => {
  const s = await fixture();
  await attachImageAssetFile(db, clock, s.ops, s.input);
  const d = await start(s);
  const [file] = await db.select().from(imageAssetFiles).where(eq(imageAssetFiles.assetId, s.a.id));
  const tamper = () =>
    db
      .update(imageAssetFiles)
      .set({ sha256: "0".repeat(64) })
      .where(eq(imageAssetFiles.assetId, s.a.id));
  const restore = () =>
    db.update(imageAssetFiles).set({ sha256: file!.sha256 }).where(eq(imageAssetFiles.assetId, s.a.id));
  await tamper();
  expect(await addDeliveryVersion(db, clock, s.ops, d.id, { artifactDir: "/fixture" })).toMatchObject({
    ok: false,
    error: "image_rights_changed",
  });
  await restore();
  // 運営の許諾（本番使用可）を外しても、版の追加・共有は止めない
  await db.update(imageAssets).set({ allowProduction: false }).where(eq(imageAssets.id, s.a.id));
  const v = must(await addDeliveryVersion(db, clock, s.ops, d.id, { artifactDir: "/fixture" }));
  must(await transitionDelivery(db, clock, s.ops, d.id, "ops_review"));
  await tamper();
  expect(await sendToCustomerReview(db, clock, s.ops, d.id, { versionId: v.id })).toMatchObject({
    ok: false,
    error: "image_rights_changed",
  });
  await restore();
  const review = must(await sendToCustomerReview(db, clock, s.ops, d.id, { versionId: v.id }));
  await tamper();
  expect((await verifyShareLink(db, clock, review.issued.token)).ok).toBe(false);
  const approve = { versionId: v.id, decision: "approved" as const, imageRightsConsent: CUSTOMER_IMAGE_CONSENT };
  expect((await decideAsCustomer(db, clock, review.issued.token, approve)).ok).toBe(false);
  await restore();
  must(await decideAsCustomer(db, clock, review.issued.token, approve));
  await tamper();
  expect(await recordPublication(db, clock, s.ops, d.id, { environment: "production" })).toMatchObject({
    ok: false,
    error: "image_rights_changed",
  });
  await restore();
  must(await recordPublication(db, clock, s.ops, d.id, { environment: "production" }));
});
it("他社の画像・破損したファイル・不正な素材記録を採用しない", async () => {
  const s = await fixture(),
    other = await fixture();
  await attachImageAssetFile(db, clock, s.ops, s.input);
  await allow(s);
  const d = await start(s);
  await attachImageAssetFile(db, clock, other.ops, other.input);
  await allow(other);
  const [build] = await db.select().from(deliveryBuilds).where(eq(deliveryBuilds.id, d.currentBuildId!));
  const snap = build!.imageAssetSnapshot as DeliveryImageAsset[];
  await db
    .update(deliveryBuilds)
    .set({ imageAssetSnapshot: [{ ...snap[0], assetId: other.a.id }] })
    .where(eq(deliveryBuilds.id, d.currentBuildId!));
  expect(await deliveryImageAssetsValid(db, d.currentBuildId!, d.id)).toBe(false);
  await db.update(deliveryBuilds).set({ imageAssetSnapshot: snap }).where(eq(deliveryBuilds.id, d.currentBuildId!));
  await db.update(imageAssetFiles).set({ pngBase64: "broken" }).where(eq(imageAssetFiles.assetId, s.a.id));
  await expect(loadDeliveryImageAssets(db, d.currentBuildId!, d.id)).rejects.toThrow("整合性");
  expect(await getImageAssetFile(db, s.ops, s.a.id)).toBeNull();
});
