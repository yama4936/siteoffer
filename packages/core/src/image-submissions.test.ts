import { randomUUID } from "node:crypto";
import {
  contentAccess,
  contracts,
  type Db,
  deliveryBuilds,
  imageAssetFiles,
  imageAssets,
  imageSubmissionOperations,
  imageSubmissions,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import { createDeliveryForContract } from "./delivery/delivery.ts";
import { seedDeliveryBase } from "./delivery/test-helpers.ts";
import { captureDeliveryImageAssets, deliveryImageAssetsValid } from "./image-assets.ts";
import {
  countPendingImageSubmissions,
  getCustomerImageFile,
  listCustomerImages,
  listImageSubmissionsForOps,
  reviewCustomerImage,
  reviseCustomerImage,
  submitCustomerImage,
  withdrawCustomerImage,
} from "./image-submissions.ts";

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
async function member(b: Awaited<ReturnType<typeof seedDeliveryBase>>) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.test`,
      displayName: "顧客の検証",
      role: "customer",
      passwordHash: "not-used",
    })
    .returning();
  const [access] = await db
    .insert(contentAccess)
    .values({
      companyId: b.company.id,
      contractId: b.contract.id,
      email: user!.email,
      userId: user!.id,
      status: "active",
      tokenHash: randomUUID(),
      expiresAt: clock.now(),
      requestId: randomUUID(),
      createdBy: b.ops.userId,
      acceptedAt: clock.now(),
      updatedAt: clock.now(),
    })
    .returning();
  return { actor: { kind: "customer_user" as const, userId: user!.id }, access: access! };
}
async function setup() {
  const b = await seedDeliveryBase(db),
    m = await member(b);
  return {
    ...b,
    ...m,
    input: {
      companyId: b.company.id,
      requestId: randomUUID(),
      label: "店舗の外観",
      rightsBasis: "own_work" as const,
      rightsNote: "当社スタッフが撮影しました。ホームページのメイン画像に利用できます。",
      requestedDemo: false,
      requestedProduction: true,
      confirmed: true,
      png,
      width: 2,
      height: 2,
    },
  };
}
function review(s: Awaited<ReturnType<typeof setup>>, assetId: string, revision = 1) {
  return {
    companyId: s.company.id,
    assetId,
    revision,
    requestId: randomUUID(),
    decision: "accepted" as const,
    note: "自社撮影であることと公開サイトへの掲載許可を確認しました。",
    allowDemo: false,
    allowProduction: true,
    confirmed: true,
  };
}
it("画像・説明・用途を一括保存し、初期状態では営業にも本番にも使わない", async () => {
  const s = await setup(),
    r = await submitCustomerImage(db, clock, s.actor, s.input);
  expect(r.item).toMatchObject({
    status: "pending",
    revision: 1,
    rightsBasis: "own_work",
    requestedProduction: true,
    allowProduction: false,
    allowSalesDemo: false,
    placement: "reference",
  });
  expect((await db.select().from(imageAssets))[0]!).toMatchObject({
    sourceType: "customer_upload",
    rightsStatus: "unknown",
    confirmedBy: null,
  });
  expect((await getCustomerImageFile(db, s.actor, r.item.assetId))!.bytes).toEqual(png);
  expect(await countPendingImageSubmissions(db, s.ops)).toBe(1);
  expect(await db.transaction((tx) => captureDeliveryImageAssets(tx, s.contract.id))).toEqual([]);
  const listing = await listCustomerImages(db, s.actor, s.company.id);
  expect(listing.total).toBe(1);
  expect(JSON.stringify(listing)).not.toContain(png.toString("base64"));
  const ops = await listImageSubmissionsForOps(db, s.ops, { pendingOnly: true });
  expect(ops.items[0]).toMatchObject({ companyName: s.company.name, submitterName: "顧客の検証" });
});
it("同じ受付の再送は重複せず、別内容での番号再利用と同じ画像の重複提出を拒否する", async () => {
  const s = await setup(),
    first = await submitCustomerImage(db, clock, s.actor, s.input);
  expect(await submitCustomerImage(db, clock, s.actor, s.input)).toMatchObject({
    replayed: true,
    item: { assetId: first.item.assetId },
  });
  await expect(submitCustomerImage(db, clock, s.actor, { ...s.input, label: "別の説明" })).rejects.toThrow(
    "同じ受付番号",
  );
  await expect(submitCustomerImage(db, clock, s.actor, { ...s.input, requestId: randomUUID() })).rejects.toThrow(
    "同じ画像",
  );
  expect(await db.select().from(imageAssets)).toHaveLength(1);
  expect(await db.select().from(imageAssetFiles)).toHaveLength(1);
  expect(await db.select().from(imageSubmissionOperations)).toHaveLength(1);
});
it("他社・同じ会社の他人・営業には提出画像の閲覧や変更を許可しない", async () => {
  const s = await setup(),
    other = await setup(),
    peer = await member(s),
    first = await submitCustomerImage(db, clock, s.actor, s.input),
    patch = { ...s.input, assetId: first.item.assetId, revision: 1, requestId: randomUUID() };
  await expect(submitCustomerImage(db, clock, other.actor, s.input)).rejects.toThrow("利用できません");
  await expect(submitCustomerImage(db, clock, s.sales, s.input)).rejects.toThrow("顧客");
  for (const actor of [other.actor, peer.actor, s.sales, null])
    await expect(getCustomerImageFile(db, actor, first.item.assetId)).rejects.toThrow();
  await expect(reviseCustomerImage(db, clock, peer.actor, patch)).rejects.toThrow("自分が提出");
  await expect(withdrawCustomerImage(db, clock, peer.actor, patch)).rejects.toThrow("自分が提出");
  expect((await listCustomerImages(db, peer.actor, s.company.id)).items).toEqual([]);
  await expect(listImageSubmissionsForOps(db, s.actor)).rejects.toThrow("運営");
  await expect(reviewCustomerImage(db, clock, s.actor, review(s, first.item.assetId))).rejects.toThrow("運営");
});
it.each(["access", "contract", "account"])(
  "%s停止後は既存画面の取得・変更・受付結果の再取得も拒否する",
  async (kind) => {
    const s = await setup(),
      r = await submitCustomerImage(db, clock, s.actor, s.input);
    if (kind === "access")
      await db.update(contentAccess).set({ status: "revoked" }).where(eq(contentAccess.id, s.access.id));
    if (kind === "contract")
      await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, s.contract.id));
    if (kind === "account") await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.actor.userId));
    await expect(submitCustomerImage(db, clock, s.actor, s.input)).rejects.toThrow();
    await expect(getCustomerImageFile(db, s.actor, r.item.assetId)).rejects.toThrow();
    await expect(listCustomerImages(db, s.actor, s.company.id)).rejects.toThrow();
    expect(await db.select().from(imageAssets)).toHaveLength(1);
  },
);
it("差し戻しと説明の再提出は版を進め、古い確認からの採用を拒否する", async () => {
  const s = await setup(),
    first = await submitCustomerImage(db, clock, s.actor, s.input),
    r = review(s, first.item.assetId);
  const sentBack = await reviewCustomerImage(db, clock, s.ops, {
    ...r,
    decision: "needs_changes",
    note: "撮影者と人物の掲載許可について、追加で教えてください。",
  });
  expect(sentBack.item).toMatchObject({ status: "needs_changes", revision: 2, allowProduction: false });
  const revised = await reviseCustomerImage(db, clock, s.actor, {
    ...s.input,
    assetId: first.item.assetId,
    revision: 2,
    requestId: randomUUID(),
    rightsNote: "撮影者は弊社社員です。写真の人物から掲載許可を得ています。",
  });
  expect(revised.item).toMatchObject({ status: "pending", revision: 3 });
  await expect(reviewCustomerImage(db, clock, s.ops, { ...r, requestId: randomUUID() })).rejects.toThrow(
    "変わりました",
  );
  const accepted = await reviewCustomerImage(db, clock, s.ops, review(s, first.item.assetId, 3));
  expect(accepted.item).toMatchObject({ status: "accepted", revision: 4, allowProduction: true });
  await expect(
    reviseCustomerImage(db, clock, s.actor, {
      ...s.input,
      assetId: first.item.assetId,
      revision: 4,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow("変わりました");
  expect((await db.select().from(imageAssetFiles))[0]!.pngBase64).toBe(png.toString("base64"));
});
it("用途の拡大を拒否し、取り下げ後は確認済みの用途も停止する", async () => {
  const s = await setup(),
    first = await submitCustomerImage(db, clock, s.actor, s.input),
    r = review(s, first.item.assetId);
  await expect(reviewCustomerImage(db, clock, s.ops, { ...r, allowDemo: true })).rejects.toThrow("顧客が許可");
  await reviewCustomerImage(db, clock, s.ops, r);
  const withdraw = {
    companyId: s.company.id,
    assetId: first.item.assetId,
    revision: 2,
    requestId: randomUUID(),
    confirmed: true,
  };
  const stopped = await withdrawCustomerImage(db, clock, s.actor, withdraw);
  expect(stopped.item).toMatchObject({
    status: "withdrawn",
    allowProduction: false,
    allowSalesDemo: false,
    placement: "reference",
    revision: 3,
  });
  expect(await withdrawCustomerImage(db, clock, s.actor, withdraw)).toMatchObject({ replayed: true });
  expect(await reviewCustomerImage(db, clock, s.ops, r)).toMatchObject({
    replayed: true,
    item: { status: "withdrawn", allowProduction: false },
  });
  await expect(reviewCustomerImage(db, clock, s.ops, review(s, first.item.assetId, 3))).rejects.toThrow("変わりました");
  const [asset] = await db.select().from(imageAssets);
  expect(asset).toMatchObject({ rightsStatus: "unknown", confirmedBy: null, confirmedAt: null });
});
it("確認チェック・用途・説明・正規化画像の形式を検査する", async () => {
  const s = await setup();
  for (const change of [
    { confirmed: false },
    { requestedProduction: false },
    { rightsNote: "短い" },
    { label: "" },
    { png: Buffer.from("invalid") },
    { width: 3000 },
  ])
    await expect(submitCustomerImage(db, clock, s.actor, { ...s.input, ...change })).rejects.toThrow();
  expect(await db.select().from(imageAssets)).toHaveLength(0);
  const r = await submitCustomerImage(db, clock, s.actor, s.input);
  await expect(
    reviewCustomerImage(db, clock, s.ops, { ...review(s, r.item.assetId), confirmed: false }),
  ).rejects.toThrow("確認");
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  await expect(reviewCustomerImage(db, clock, s.ops, review(s, r.item.assetId))).rejects.toThrow("運営");
});
it("会社の保存容量を超える提出は全体を残さず拒否する", async () => {
  const s = await setup(),
    first = await submitCustomerImage(db, clock, s.actor, s.input);
  await db
    .update(imageAssetFiles)
    .set({ byteSize: 256 * 1024 * 1024 })
    .where(eq(imageAssetFiles.assetId, first.item.assetId));
  await expect(
    submitCustomerImage(db, clock, s.actor, {
      ...s.input,
      png: Buffer.concat([png, Buffer.from("quota-test")]),
      requestId: randomUUID(),
    }),
  ).rejects.toThrow("上限");
  expect(await db.select().from(imageAssets)).toHaveLength(1);
});
it("監査エラー時は素材・ファイル・受付記録をまとめて戻す", async () => {
  const s = await setup();
  await db.execute(
    sql`CREATE FUNCTION reject_submission_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'image_submission.submitted' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER reject_submission_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_submission_audit()`,
  );
  await expect(submitCustomerImage(db, clock, s.actor, s.input)).rejects.toThrow();
  for (const table of [imageAssets, imageAssetFiles, imageSubmissions, imageSubmissionOperations])
    expect(await db.select().from(table)).toHaveLength(0);
});

it("採用した画像を制作に固定し、取り下げると既存の制作回も利用不可になる", async () => {
  const s = await setup();
  const submitted = await submitCustomerImage(db, clock, s.actor, s.input);
  await reviewCustomerImage(db, clock, s.ops, review(s, submitted.item.assetId));
  // Placement is a separate operator choice after rights approval.
  await db.update(imageAssets).set({ placement: "hero" }).where(eq(imageAssets.id, submitted.item.assetId));
  const snapshot = await db.transaction((tx) => captureDeliveryImageAssets(tx, s.contract.id));
  expect(snapshot).toHaveLength(1);
  const result = await createDeliveryForContract(db, clock, s.ops, s.contract.id);
  if (!result.ok) throw new Error(result.error);
  const deliveryId = result.value.delivery.id;
  const [build] = await db.insert(deliveryBuilds).values({ deliveryId, imageAssetSnapshot: snapshot }).returning();
  expect(await deliveryImageAssetsValid(db, build!.id, deliveryId)).toBe(true);
  await withdrawCustomerImage(db, clock, s.actor, {
    companyId: s.company.id,
    assetId: submitted.item.assetId,
    revision: 2,
    requestId: randomUUID(),
    confirmed: true,
  });
  expect(await deliveryImageAssetsValid(db, build!.id, deliveryId)).toBe(false);
  expect(await db.transaction((tx) => captureDeliveryImageAssets(tx, s.contract.id))).toEqual([]);
});
