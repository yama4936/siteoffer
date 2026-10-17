import { createHash, randomUUID } from "node:crypto";
import {
  contentAccess,
  contentEntries,
  contentOperations,
  contentRevisions,
  type Db,
  deliveries,
  imageAssetFiles,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import { publishArticle, saveArticle } from "./content.ts";
import { getArticleEditorImage, listArticleImageChoices, parseArticleImages } from "./content-images.ts";
import { commitArticleImport, previewArticleImport } from "./content-import.ts";
import { findPublishedArticle, getPublishedArticleImage, listPublishedArticles } from "./content-published.ts";
import { loadArticleWorkspace, saveArticleWorkingCopy, submitArticleOperation } from "./content-workspace.ts";
import { createDeliveryForContract } from "./delivery/delivery.ts";
import { seedDeliveryBase } from "./delivery/test-helpers.ts";
import { reviewCustomerImage, submitCustomerImage, withdrawCustomerImage } from "./image-submissions.ts";

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
async function setup() {
  const b = await seedDeliveryBase(db);
  const [u] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.test`,
      displayName: "写真記事の顧客",
      role: "customer",
      passwordHash: "fixture",
    })
    .returning();
  const [access] = await db
    .insert(contentAccess)
    .values({
      companyId: b.company.id,
      contractId: b.contract.id,
      email: u!.email,
      userId: u!.id,
      status: "active",
      tokenHash: randomUUID(),
      expiresAt: clock.now(),
      requestId: randomUUID(),
      createdBy: b.ops.userId,
      acceptedAt: clock.now(),
      updatedAt: clock.now(),
    })
    .returning();
  const delivery = await createDeliveryForContract(db, clock, b.ops, b.contract.id);
  if (!delivery.ok) throw Error(delivery.error);
  const actor = { kind: "customer_user" as const, userId: u!.id };
  const input = {
    companyId: b.company.id,
    requestId: randomUUID(),
    label: "自社の店舗",
    rightsBasis: "own_work" as const,
    rightsNote: "当社で撮影しホームページへの利用を許可します。",
    requestedDemo: false,
    requestedProduction: true,
    confirmed: true,
    png,
    width: 2,
    height: 2,
  };
  const submitted = await submitCustomerImage(db, clock, actor, input);
  const image = { assetId: submitted.item.assetId, alt: "青い看板の店舗の外観", caption: "自社スタッフ撮影" };
  return { ...b, actor, access: access!, input, image, delivery: delivery.value.delivery };
}
async function approve(s: Awaited<ReturnType<typeof setup>>) {
  return reviewCustomerImage(db, clock, s.ops, {
    companyId: s.company.id,
    assetId: s.image.assetId,
    revision: 1,
    requestId: randomUUID(),
    decision: "accepted",
    note: "撮影者と公開サイトへの利用許諾を確認しました。",
    allowDemo: false,
    allowProduction: true,
    confirmed: true,
  });
}
async function article(s: Awaited<ReturnType<typeof setup>>, images = [s.image]) {
  return saveArticle(db, clock, s.actor, {
    companyId: s.company.id,
    slug: `news-${randomUUID().slice(0, 8)}`,
    title: "写真付きのお知らせ",
    body: "写真のある記事本文",
    category: "news",
    images,
  });
}
async function publish(s: Awaited<ReturnType<typeof setup>>, e: Awaited<ReturnType<typeof article>>, revision = 1) {
  return publishArticle(db, clock, s.actor, {
    companyId: s.company.id,
    entryId: e.id,
    revision,
    expectedRevision: e.currentRevision,
    expectedPublicationRevision: e.publicationRevision,
  });
}
it("写真の説明を作業コピーから復元し、共有保存の再送でも後続入力を消さない", async () => {
  const s = await setup(),
    scope = { companyId: s.company.id, entryId: null };
  const values = {
    slug: "photos",
    title: "写真記事",
    body: "本文",
    category: "blog",
    baseRevision: "0",
    images: [s.image],
  };
  await saveArticleWorkingCopy(db, clock, s.actor, scope, 0, values);
  expect((await loadArticleWorkspace(db, s.actor, scope)).copy.values).toEqual(values);
  const request = { kind: "save" as const, requestId: randomUUID(), copyRevision: 1 };
  const r = await submitArticleOperation(db, clock, s.actor, scope, request);
  expect(r.workspace.current.images).toEqual(values.images);
  await saveArticleWorkingCopy(db, clock, s.actor, r.workspace.scope, 0, {
    ...r.workspace.current,
    images: [{ ...s.image, caption: "次の入力" }],
  });
  const retry = await submitArticleOperation(db, clock, s.actor, scope, request);
  expect(retry.replayed).toBe(true);
  expect(retry.workspace.copy.values?.images?.[0]?.caption).toBe("次の入力");
  expect(await db.select().from(contentRevisions)).toHaveLength(1);
});
it("未確認の自分の写真は下書きで使え、承認後だけ掲載できる", async () => {
  const s = await setup(),
    e = await article(s);
  expect((await listArticleImageChoices(db, s.actor, s.company.id))[0]?.approved).toBe(false);
  expect((await getArticleEditorImage(db, s.actor, s.company.id, s.image.assetId))?.bytes).toEqual(png);
  await expect(publish(s, e)).rejects.toThrow("利用許諾");
  expect((await db.select().from(contentEntries))[0]?.publishedRevision).toBeNull();
  await approve(s);
  await publish(s, e);
  expect((await findPublishedArticle(db, s.company.id, e.slug))?.images).toEqual([s.image]);
});
it("写真の版は本文と一緒に固定し、未掲載の説明は出さず、過去の版へ戻せる", async () => {
  const s = await setup();
  await approve(s);
  const first = await article(s);
  await publish(s, first);
  const second = await saveArticle(db, clock, s.actor, {
    companyId: s.company.id,
    entryId: first.id,
    expectedRevision: 1,
    slug: first.slug,
    title: "新しい記事",
    body: "次の本文",
    category: "blog",
    images: [{ ...s.image, caption: "未掲載の説明" }],
  });
  expect((await findPublishedArticle(db, s.company.id, first.slug))?.images[0]?.caption).toBe(s.image.caption);
  await publishArticle(db, clock, s.actor, {
    companyId: s.company.id,
    entryId: first.id,
    expectedRevision: second.currentRevision,
    expectedPublicationRevision: 1,
    revision: 2,
  });
  expect((await findPublishedArticle(db, s.company.id, first.slug))?.images[0]?.caption).toBe("未掲載の説明");
  await publishArticle(db, clock, s.actor, {
    companyId: s.company.id,
    entryId: first.id,
    expectedRevision: 2,
    expectedPublicationRevision: 2,
    revision: 1,
  });
  expect((await findPublishedArticle(db, s.company.id, first.slug))?.images).toEqual([s.image]);
});
it("取り下げた写真は一覧・本文・直接配信から消し、記事の文章と版は保持する", async () => {
  const s = await setup();
  await approve(s);
  const e = await article(s);
  await publish(s, e);
  await db.update(deliveries).set({ status: "published" }).where(eq(deliveries.id, s.delivery.id));
  expect((await getPublishedArticleImage(db, s.company.id, e.id, s.image.assetId))?.bytes).toEqual(png);
  await withdrawCustomerImage(db, clock, s.actor, {
    companyId: s.company.id,
    assetId: s.image.assetId,
    revision: 2,
    requestId: randomUUID(),
    confirmed: true,
  });
  const current = await findPublishedArticle(db, s.company.id, e.slug);
  expect(current?.images).toEqual([]);
  expect(current?.body).toBe("写真のある記事本文");
  expect(
    (await listPublishedArticles(db, s.company.id, { page: 1, query: "", category: "all" })).items[0]?.images,
  ).toEqual([]);
  expect(await getPublishedArticleImage(db, s.company.id, e.id, s.image.assetId)).toBeNull();
  await expect(
    publishArticle(db, clock, s.actor, {
      companyId: s.company.id,
      entryId: e.id,
      revision: 1,
      expectedRevision: 1,
      expectedPublicationRevision: 1,
    }),
  ).rejects.toThrow("利用許諾");
});
it("未公開サイト・未掲載記事・別記事・別会社の写真を直接指定で公開しない", async () => {
  const s = await setup(),
    foreign = await setup();
  await approve(s);
  await approve(foreign);
  const e = await article(s);
  await publish(s, e);
  expect(await getPublishedArticleImage(db, s.company.id, e.id, s.image.assetId)).toBeNull();
  await db.update(deliveries).set({ status: "published" }).where(eq(deliveries.id, s.delivery.id));
  expect(await getPublishedArticleImage(db, s.company.id, randomUUID(), s.image.assetId)).toBeNull();
  expect(await getPublishedArticleImage(db, s.company.id, e.id, foreign.image.assetId)).toBeNull();
  await publishArticle(db, clock, s.actor, {
    companyId: s.company.id,
    entryId: e.id,
    revision: null,
    expectedRevision: 1,
    expectedPublicationRevision: 1,
  });
  expect(await getPublishedArticleImage(db, s.company.id, e.id, s.image.assetId)).toBeNull();
});
it("他社の画像参照で共有保存を拒否し、自分の作業コピーと操作受付を守る", async () => {
  const s = await setup(),
    foreign = await setup();
  expect(await getArticleEditorImage(db, s.actor, s.company.id, foreign.image.assetId)).toBeNull();
  await expect(listArticleImageChoices(db, s.actor, foreign.company.id)).rejects.toThrow("利用できません");
  const scope = { companyId: s.company.id, entryId: null };
  const values = {
    slug: "foreign",
    title: "見出し",
    body: "本文",
    category: "news",
    baseRevision: "0",
    images: [foreign.image],
  };
  await saveArticleWorkingCopy(db, clock, s.actor, scope, 0, values);
  await expect(
    submitArticleOperation(db, clock, s.actor, scope, { kind: "save", requestId: randomUUID(), copyRevision: 1 }),
  ).rejects.toThrow("写真が見つかりません");
  expect((await loadArticleWorkspace(db, s.actor, scope)).copy.values).toEqual(values);
  expect(await db.select().from(contentOperations)).toHaveLength(0);
});
it("利用権限の失効と停止ユーザーを選択・画像配信でも再検査する", async () => {
  const s = await setup();
  await approve(s);
  await db.update(contentAccess).set({ status: "revoked" }).where(eq(contentAccess.id, s.access.id));
  await expect(getArticleEditorImage(db, s.actor, s.company.id, s.image.assetId)).rejects.toThrow("利用できません");
  await expect(listArticleImageChoices(db, null, s.company.id)).rejects.toThrow("権限");
  await expect(listArticleImageChoices(db, s.sales, s.company.id)).rejects.toThrow("権限");
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  await expect(getArticleEditorImage(db, s.ops, s.company.id, s.image.assetId)).rejects.toThrow("有効な運営");
});
it("破損した画像を配信せず、代替テキストのない写真は掲載しない", async () => {
  const s = await setup();
  await approve(s);
  const e = await article(s, [{ ...s.image, alt: " " }]);
  await expect(publish(s, e)).rejects.toThrow("代替テキスト");
  await db
    .update(imageAssetFiles)
    .set({ sha256: createHash("sha256").update("invalid").digest("hex") })
    .where(eq(imageAssetFiles.assetId, s.image.assetId));
  expect(await getArticleEditorImage(db, s.actor, s.company.id, s.image.assetId)).toBeNull();
});
it("同じ会社でも他の顧客の未確認写真を見せず、承認後は会社の素材として使える", async () => {
  const s = await setup(),
    other = await setup();
  const [u] = await db.select().from(users).where(eq(users.id, other.actor.userId));
  await db.insert(contentAccess).values({
    companyId: s.company.id,
    contractId: s.contract.id,
    email: u!.email,
    userId: u!.id,
    status: "active",
    tokenHash: randomUUID(),
    expiresAt: clock.now(),
    requestId: randomUUID(),
    createdBy: s.ops.userId,
    updatedAt: clock.now(),
  });
  expect(await listArticleImageChoices(db, other.actor, s.company.id)).toEqual([]);
  expect(await getArticleEditorImage(db, other.actor, s.company.id, s.image.assetId)).toBeNull();
  await approve(s);
  expect((await listArticleImageChoices(db, other.actor, s.company.id)).map((i) => i.id)).toEqual([s.image.assetId]);
  expect((await getArticleEditorImage(db, other.actor, s.company.id, s.image.assetId))?.bytes).toEqual(png);
});
it("重複・9枚以上・不正なID・過長な説明・不明フィールドを拒否する", () => {
  const image = { assetId: randomUUID(), alt: "", caption: "" };
  expect(parseArticleImages([image])).toEqual([image]);
  expect(() => parseArticleImages([{ ...image, caption: "password=12345678" }])).toThrow("秘密情報");
  for (const raw of [
    [image, image],
    Array.from({ length: 9 }, () => ({ ...image, assetId: randomUUID() })),
    [{ ...image, assetId: "../file" }],
    [{ ...image, caption: "a".repeat(401) }],
    [{ ...image, extra: true }],
  ])
    expect(() => parseArticleImages(raw)).toThrow();
});
it("JSONの写真参照を取り込み、同じ写真を重複取込せず、他社の参照を拒否する", async () => {
  const s = await setup(),
    foreign = await setup();
  const values = { slug: "import-photos", title: "移行記事", body: "説明", category: "news", images: [s.image] };
  const source = {
    companyId: s.company.id,
    format: "json" as const,
    fileName: "articles.json",
    text: JSON.stringify([values]),
  };
  const plan = await previewArticleImport(db, s.ops, source);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  const r = await commitArticleImport(db, clock, s.ops, {
    ...source,
    requestId: randomUUID(),
    fingerprint: plan.value.fingerprint,
    confirmed: true,
  });
  expect(r.ok).toBe(true);
  expect((await db.select().from(contentRevisions))[0]?.images).toEqual([s.image]);
  const repeat = await previewArticleImport(db, s.ops, source);
  expect(repeat.ok && repeat.value.rows[0]?.status).toBe("identical");
  const invalid = await previewArticleImport(db, s.ops, {
    ...source,
    text: JSON.stringify([{ ...values, slug: "other", images: [foreign.image] }]),
  });
  expect(invalid.ok && invalid.value.errors.length).toBe(1);
});
