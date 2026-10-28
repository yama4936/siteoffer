import { randomUUID } from "node:crypto";
import {
  approvals,
  auditEvents,
  type Db,
  deliveries,
  deliveryBuilds,
  imageAssetFiles,
  imageAssets,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { and, eq, sql } from "drizzle-orm";
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
import { attachImageAssetFile } from "./image-assets.ts";
import {
  deliveryVersionImageConsent,
  evaluateImageRightsConsent,
  IMAGE_RIGHTS_CONSENT_ACTION,
  IMAGE_RIGHTS_CONSENT_TEXT_HASH,
  IMAGE_RIGHTS_CONSENT_VERSION,
  imageSetFingerprint,
} from "./image-rights-consent.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-28T00:00:00Z");
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

/** 運営の許諾が未確認のままの素材で、顧客確認まで進める */
async function underReview(withImage = true) {
  const b = await seedDeliveryBase(db);
  let assetId: string | null = null;
  if (withImage) {
    const [a] = await db
      .insert(imageAssets)
      .values({ companyId: b.company.id, label: "顧客のロゴ", sourceType: "operator_upload", placement: "logo" })
      .returning();
    assetId = a!.id;
    await attachImageAssetFile(db, clock, b.ops, { companyId: b.company.id, assetId, png, width: 2, height: 2 });
  }
  const { delivery } = must(await createDeliveryForContract(db, clock, b.ops, b.contract.id));
  const d = must(await transitionDelivery(db, clock, b.ops, delivery.id, "building"));
  const v = must(await addDeliveryVersion(db, clock, b.ops, d.id, { artifactDir: "/fixture" }));
  must(await transitionDelivery(db, clock, b.ops, d.id, "ops_review"));
  const review = must(await sendToCustomerReview(db, clock, b.ops, d.id, { versionId: v.id }));
  return { ...b, d, v, assetId, token: review.issued.token, linkId: review.issued.link.id };
}
const consentEvents = () => db.select().from(auditEvents).where(eq(auditEvents.action, IMAGE_RIGHTS_CONSENT_ACTION));

it("画像の権利への同意がない・文言の版が違う承認は入力エラーにし、何も記録しない", async () => {
  const s = await underReview();
  for (const imageRightsConsent of [
    undefined,
    null,
    { accepted: false, textVersion: IMAGE_RIGHTS_CONSENT_VERSION },
    { accepted: true, textVersion: "2026-01-01.v0" },
  ])
    expect(
      await decideAsCustomer(db, clock, s.token, { versionId: s.v.id, decision: "approved", imageRightsConsent }),
    ).toMatchObject({ ok: false, error: "invalid_input" });
  expect(await db.select().from(approvals)).toHaveLength(0);
  expect(await consentEvents()).toHaveLength(0);
  expect((await db.select().from(deliveries))[0]).toMatchObject({ status: "customer_review", lockedVersionId: null });
  // 修正依頼には同意は不要
  must(
    await decideAsCustomer(db, clock, s.token, { versionId: s.v.id, decision: "changes_requested", comment: "修正" }),
  );
  expect(await consentEvents()).toHaveLength(0);
});

it("承認と同時に、版・制作回・承認・共有リンク・文言・画像の組を会社の監査記録に残す", async () => {
  const s = await underReview();
  const r = must(
    await decideAsCustomer(db, clock, s.token, {
      versionId: s.v.id,
      decision: "approved",
      imageRightsConsent: CUSTOMER_IMAGE_CONSENT,
    }),
  );
  const [event] = await consentEvents();
  const [file] = await db.select().from(imageAssetFiles).where(eq(imageAssetFiles.assetId, s.assetId!));
  const images = [{ assetId: s.assetId!, slot: "logo", sha256: file!.sha256 }];
  expect(event).toMatchObject({
    actorKind: "customer",
    targetType: "company",
    targetId: s.company.id,
    after: {
      deliveryId: s.d.id,
      versionId: s.v.id,
      version: s.v.version,
      buildId: s.v.buildId,
      approvalId: r.approvalId,
      shareLinkId: s.linkId,
      textVersion: IMAGE_RIGHTS_CONSENT_VERSION,
      textHash: IMAGE_RIGHTS_CONSENT_TEXT_HASH,
      consentedAt: clock.now().toISOString(),
      images,
      imagesFingerprint: imageSetFingerprint(images),
    },
  });
  expect(JSON.stringify(event)).not.toContain(s.token);
  expect(await deliveryVersionImageConsent(db, s.v.id)).toMatchObject({ ok: true, basis: "customer_consent" });
  // 運営の許諾が未確認のままでも、顧客の同意で公開できる
  expect((await db.select().from(imageAssets))[0]!.rightsStatus).toBe("unknown");
  must(await recordPublication(db, clock, s.ops, s.d.id, { environment: "production" }));
});

it("同意の記録に失敗したら承認と納品の状態もまとめて戻す", async () => {
  const s = await underReview();
  await db.execute(
    sql`create function fail_consent() returns trigger language plpgsql as $$ begin if new.action = 'image_rights.customer_consent' then raise exception 'fixture'; end if; return new; end $$`,
  );
  await db.execute(
    sql`create trigger fail_consent before insert on audit_events for each row execute function fail_consent()`,
  );
  await expect(
    decideAsCustomer(db, clock, s.token, {
      versionId: s.v.id,
      decision: "approved",
      imageRightsConsent: CUSTOMER_IMAGE_CONSENT,
    }),
  ).rejects.toThrow();
  expect(await db.select().from(approvals)).toHaveLength(0);
  expect((await db.select().from(deliveries))[0]).toMatchObject({ status: "customer_review", lockedVersionId: null });
});

it("同意した画像の組が変わる・ファイルが変わる・顧客が取り下げると、公開できず再承認が必要になる", async () => {
  const s = await underReview();
  must(
    await decideAsCustomer(db, clock, s.token, {
      versionId: s.v.id,
      decision: "approved",
      imageRightsConsent: CUSTOMER_IMAGE_CONSENT,
    }),
  );
  const [event] = await consentEvents();
  const after = event!.after as { images: { assetId: string; slot: string; sha256: string }[] };
  // 同意した画像の組（配置）と版の画像の組が一致しない
  const changed = [{ ...after.images[0]!, slot: "hero" }];
  await db
    .update(auditEvents)
    .set({ after: { ...after, images: changed, imagesFingerprint: imageSetFingerprint(changed) } })
    .where(eq(auditEvents.id, event!.id));
  expect(await deliveryVersionImageConsent(db, s.v.id)).toEqual({ ok: false, reason: "images_changed" });
  expect(await recordPublication(db, clock, s.ops, s.d.id, { environment: "production" })).toMatchObject({
    ok: false,
    error: "image_consent_required",
  });
  // 指紋が記録の画像一覧と合わない（改変された）記録も無効
  await db
    .update(auditEvents)
    .set({ after: { ...after, imagesFingerprint: "0".repeat(64) } })
    .where(eq(auditEvents.id, event!.id));
  expect(await deliveryVersionImageConsent(db, s.v.id)).toEqual({ ok: false, reason: "images_changed" });
  await db.update(auditEvents).set({ after }).where(eq(auditEvents.id, event!.id));
  expect((await deliveryVersionImageConsent(db, s.v.id)).ok).toBe(true);
  // ファイルハッシュの不一致・素材の消失
  await db
    .update(imageAssetFiles)
    .set({ sha256: "0".repeat(64) })
    .where(eq(imageAssetFiles.assetId, s.assetId!));
  expect(await deliveryVersionImageConsent(db, s.v.id)).toEqual({ ok: false, reason: "images_invalid" });
  expect(await recordPublication(db, clock, s.ops, s.d.id, { environment: "production" })).toMatchObject({
    ok: false,
    error: "image_rights_changed",
  });
  await db.delete(imageAssetFiles).where(eq(imageAssetFiles.assetId, s.assetId!));
  expect(await deliveryVersionImageConsent(db, s.v.id)).toEqual({ ok: false, reason: "images_invalid" });
  expect((await db.select().from(deliveries))[0]!.status).toBe("ready");
});

it("同意記録のない承認済みの旧版は、使用画像すべてに運営の旧来の許諾がある場合だけ公開できる", async () => {
  const s = await underReview();
  // 旧データ：同意の仕組みより前の承認（承認だけがあり、同意の記録はない）
  const now = clock.now();
  await db.insert(approvals).values({ deliveryVersionId: s.v.id, decision: "approved", decidedAt: now });
  await db
    .update(deliveries)
    .set({ status: "ready", lockedVersionId: s.v.id, reviewVersionId: null })
    .where(eq(deliveries.id, s.d.id));
  expect(await deliveryVersionImageConsent(db, s.v.id)).toEqual({ ok: false, reason: "no_consent" });
  expect(await recordPublication(db, clock, s.ops, s.d.id, { environment: "production" })).toMatchObject({
    ok: false,
    error: "image_consent_required",
    message: expect.stringContaining("再承認"),
  });
  const legacy = { rightsStatus: "use_approved" as const, confirmedBy: s.ops.userId, confirmedAt: now };
  // デモだけの許諾は本番の許諾にならない
  await db
    .update(imageAssets)
    .set({ ...legacy, allowSalesDemo: true })
    .where(eq(imageAssets.id, s.assetId!));
  expect((await deliveryVersionImageConsent(db, s.v.id)).ok).toBe(false);
  await db.update(imageAssets).set({ allowProduction: true }).where(eq(imageAssets.id, s.assetId!));
  expect(await deliveryVersionImageConsent(db, s.v.id)).toEqual({ ok: true, basis: "legacy_ops_permission" });
  must(await recordPublication(db, clock, s.ops, s.d.id, { environment: "production" }));
});

it("承認のない版は、旧来の許諾があっても同意と同等にしない。画像のない旧版の承認は公開できる", async () => {
  const s = await underReview();
  await db
    .update(imageAssets)
    .set({ rightsStatus: "use_approved", allowProduction: true, confirmedBy: s.ops.userId, confirmedAt: clock.now() })
    .where(eq(imageAssets.id, s.assetId!));
  expect(await deliveryVersionImageConsent(db, s.v.id)).toEqual({ ok: false, reason: "no_consent" });

  const empty = await underReview(false);
  const [build] = await db
    .select()
    .from(deliveryBuilds)
    .where(and(eq(deliveryBuilds.id, empty.v.buildId!), eq(deliveryBuilds.deliveryId, empty.d.id)));
  expect(build!.imageAssetSnapshot).toEqual([]);
  await db.insert(approvals).values({ deliveryVersionId: empty.v.id, decision: "approved", decidedAt: clock.now() });
  expect(await deliveryVersionImageConsent(db, empty.v.id)).toEqual({ ok: true, basis: "legacy_ops_permission" });
});

it("判定は画像の並び順に依存せず、同意があれば旧来の許諾を見ない", () => {
  const a = { assetId: randomUUID(), slot: "hero", sha256: "a".repeat(64) },
    b = { assetId: randomUUID(), slot: "logo", sha256: "b".repeat(64) };
  expect(imageSetFingerprint([a, b])).toBe(imageSetFingerprint([b, a]));
  expect(imageSetFingerprint([a])).not.toBe(imageSetFingerprint([{ ...a, sha256: "c".repeat(64) }]));
  const consent = {
    versionId: randomUUID(),
    textVersion: IMAGE_RIGHTS_CONSENT_VERSION,
    images: [b, a],
    imagesFingerprint: imageSetFingerprint([a, b]),
  };
  const never = () => false;
  expect(evaluateImageRightsConsent({ images: [a, b], consent, approved: true, legacyPermitted: never })).toMatchObject(
    {
      ok: true,
      basis: "customer_consent",
    },
  );
  expect(evaluateImageRightsConsent({ images: [a], consent, approved: true, legacyPermitted: () => true })).toEqual({
    ok: false,
    reason: "images_changed",
  });
  expect(
    evaluateImageRightsConsent({ images: [a], consent: null, approved: false, legacyPermitted: () => true }),
  ).toEqual({ ok: false, reason: "no_consent" });
});
