import { randomUUID } from "node:crypto";
import {
  approvals,
  auditEvents,
  type Db,
  deliveries,
  deliveryBuilds,
  deliveryVersions,
  deployments,
  imageAssetFiles,
  imageAssets,
  publicationCheckOperations,
  publicationMaterialChecks,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import { seedDeliveryBase } from "./delivery/test-helpers.ts";
import {
  confirmPublicationMaterialCheck,
  getPublicationMaterial,
  listPublicationMaterials,
  publicationUrl,
  reopenPublicationMaterialCheck,
} from "./publication-materials.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
async function setup() {
  const b = await seedDeliveryBase(db);
  const [d] = await db.insert(deliveries).values({ contractId: b.contract.id, status: "published" }).returning();
  const [a] = await db
    .insert(imageAssets)
    .values({
      companyId: b.company.id,
      label: "店舗の外観",
      sourceType: "operator_upload",
      rightsStatus: "use_approved",
      allowProduction: true,
      confirmedBy: b.ops.userId,
      confirmedAt: clock.now(),
    })
    .returning();
  await db.insert(imageAssetFiles).values({
    assetId: a!.id,
    pngBase64: "fixture",
    sha256: "a".repeat(64),
    width: 1,
    height: 1,
    byteSize: 1,
    uploadedBy: b.ops.userId,
  });
  const snapshot = [
    { assetId: a!.id, slot: "hero", label: a!.label, sha256: "a".repeat(64), policy: { allowedUses: ["production"] } },
  ];
  async function publish(
    version: number,
    options: { snapshot?: unknown; url?: string | null; env?: string; approved?: boolean } = {},
  ) {
    const [build] = await db
      .insert(deliveryBuilds)
      .values({
        deliveryId: d!.id,
        status: "succeeded",
        imageAssetSnapshot: options.snapshot === undefined ? snapshot : options.snapshot,
      })
      .returning();
    const [v] = await db
      .insert(deliveryVersions)
      .values({ deliveryId: d!.id, buildId: build!.id, version })
      .returning();
    if (options.approved !== false)
      await db.insert(approvals).values({ deliveryVersionId: v!.id, decision: "approved", decidedAt: clock.now() });
    const [dep] = await db
      .insert(deployments)
      .values({
        deliveryId: d!.id,
        deliveryVersionId: v!.id,
        status: "recorded",
        environment: options.env ?? "production",
        url: options.url === undefined ? "https://store.example.test/" : options.url,
        createdAt: new Date(clock.now().getTime() + version * 1000),
      })
      .returning();
    return { dep: dep!, version: v!, build: build! };
  }
  const first = await publish(1);
  async function listing(mode: "pending" | "resolved" | "all" = "all") {
    return listPublicationMaterials(db, b.ops, { deliveryId: d!.id, mode });
  }
  async function withdraw() {
    await db.update(imageAssets).set({ allowProduction: false, policyRevision: 1 }).where(eq(imageAssets.id, a!.id));
  }
  async function input() {
    const item = (await listing()).items.find((r) => r.deploymentId === first.dep.id)!;
    return {
      deploymentId: item.deploymentId,
      revision: item.check?.revision ?? 0,
      fingerprint: item.fingerprint,
      requestId: randomUUID(),
      outcome: "site_offline" as "site_offline" | "replaced",
      replacementId: null as string | null,
      observedUrl: "https://store.example.test/",
      note: "元の公開サイト全体が閲覧できなくなったことを確認しました。",
      confirmed: true,
    };
  }
  return { ...b, delivery: d!, asset: a!, publish, listing, withdraw, input, first };
}
it("利用許可の停止を検出し、素材なしと追跡不能の旧版を区別する", async () => {
  const s = await setup();
  expect(await s.listing()).toMatchObject({ scanned: 1, pending: 0, items: [{ state: "clear" }] });
  await s.withdraw();
  expect(await s.listing()).toMatchObject({
    pending: 1,
    items: [{ issues: [{ reason: "本番サイトでの利用許可が停止しています" }] }],
  });
  await s.publish(2, { snapshot: [] });
  await s.publish(3, { snapshot: null });
  await s.publish(4, { snapshot: { bad: true } });
  const r = await s.listing();
  expect(r.pending).toBe(3);
  expect(r.items.find((x) => x.version === 2)!.state).toBe("clear");
  expect(r.items.find((x) => x.version === 3)!.issues[0]!.reason).toContain("旧版");
  expect(JSON.stringify(r)).not.toContain("pngBase64");
});
it("保存ファイルの欠落とハッシュ不一致を検出する", async () => {
  const s = await setup();
  await db
    .update(imageAssetFiles)
    .set({ sha256: "b".repeat(64) })
    .where(eq(imageAssetFiles.assetId, s.asset.id));
  expect((await s.listing()).items[0]!.issues[0]!.reason).toContain("一致しません");
  await db.delete(imageAssetFiles).where(eq(imageAssetFiles.assetId, s.asset.id));
  expect((await s.listing()).items[0]!.issues[0]!.reason).toContain("ファイル");
});
it("外部反映の明示確認と現在の版を要求する", async () => {
  const s = await setup();
  await s.withdraw();
  const i = await s.input();
  for (const patch of [
    { confirmed: false },
    { note: "短い" },
    { observedUrl: "javascript:alert(1)" },
    { observedUrl: "https://other.example.test/" },
    { fingerprint: "old" },
    { revision: 2 },
    { replacementId: randomUUID() },
  ])
    await expect(confirmPublicationMaterialCheck(db, clock, s.ops, { ...i, ...patch })).rejects.toThrow();
  await db.update(imageAssets).set({ policyRevision: 2 }).where(eq(imageAssets.id, s.asset.id));
  await expect(confirmPublicationMaterialCheck(db, clock, s.ops, i)).rejects.toThrow("変わりました");
  expect(await db.select().from(publicationMaterialChecks)).toHaveLength(0);
});
it("再送は一度だけ記録し、再確認へ戻した後に古い再送が解決済みへ戻さない", async () => {
  const s = await setup();
  await s.withdraw();
  const i = await s.input();
  expect(await confirmPublicationMaterialCheck(db, clock, s.ops, i)).toMatchObject({
    replayed: false,
    item: { state: "resolved", check: { revision: 1 } },
  });
  expect(await confirmPublicationMaterialCheck(db, clock, s.ops, i)).toMatchObject({ replayed: true });
  await expect(confirmPublicationMaterialCheck(db, clock, s.ops, { ...i, note: `${i.note}追加` })).rejects.toThrow(
    "同じ受付番号",
  );
  const reopen = {
    deploymentId: i.deploymentId,
    revision: 1,
    requestId: randomUUID(),
    note: "確認した公開先を取り違えたため、改めて現状を確認します。",
    confirmed: true,
  };
  expect(await reopenPublicationMaterialCheck(db, clock, s.ops, reopen)).toMatchObject({
    item: { state: "pending", check: { revision: 2 } },
  });
  expect(await reopenPublicationMaterialCheck(db, clock, s.ops, reopen)).toMatchObject({ replayed: true });
  expect(await confirmPublicationMaterialCheck(db, clock, s.ops, i)).toMatchObject({
    replayed: true,
    item: { state: "pending" },
  });
  await expect(
    reopenPublicationMaterialCheck(db, clock, s.ops, { ...reopen, requestId: randomUUID() }),
  ).rejects.toThrow("変わりました");
  await confirmPublicationMaterialCheck(db, clock, s.ops, await s.input());
  expect(await db.select().from(publicationCheckOperations)).toHaveLength(3);
  expect(await db.select().from(auditEvents)).toHaveLength(3);
  expect(await db.select().from(deployments)).toHaveLength(1);
  expect(await db.select().from(imageAssets)).toHaveLength(1);
});
it("別URL・別環境・未承認の公開は旧サイトの置き換え候補にしない", async () => {
  const s = await setup();
  await s.withdraw();
  const other = await s.publish(2, { snapshot: [], url: "https://new.example.test/" });
  await s.publish(3, { snapshot: [], env: "staging" });
  await s.publish(4, { snapshot: [], approved: false });
  let i = await s.input();
  expect((await s.listing()).items.find((x) => x.version === 1)!.replacements).toHaveLength(0);
  await expect(
    confirmPublicationMaterialCheck(db, clock, s.ops, { ...i, outcome: "replaced", replacementId: other.dep.id }),
  ).rejects.toThrow("同じ公開先");
  const good = await s.publish(5, { snapshot: [] });
  expect((await s.listing()).items.find((x) => x.version === 1)!.replacements.map((x) => x.deploymentId)).toEqual([
    good.dep.id,
  ]);
  await s.publish(6); // newer publication with withdrawn asset prevents selecting older clean publication
  await expect(
    confirmPublicationMaterialCheck(db, clock, s.ops, { ...i, outcome: "replaced", replacementId: good.dep.id }),
  ).rejects.toThrow("同じ公開先");
  const latest = await s.publish(7, { snapshot: [] });
  i = await s.input();
  expect(
    await confirmPublicationMaterialCheck(db, clock, s.ops, {
      ...i,
      outcome: "replaced",
      replacementId: latest.dep.id,
    }),
  ).toMatchObject({ item: { state: "resolved" } });
});
it("置き換え後の素材問題は新公開の要確認になり、旧版の完了記録を壊さない", async () => {
  const s = await setup();
  await s.withdraw();
  const [asset] = await db
    .insert(imageAssets)
    .values({
      companyId: s.company.id,
      label: "新しい外観",
      sourceType: "operator_upload",
      allowProduction: true,
      rightsStatus: "use_approved",
      confirmedBy: s.ops.userId,
      confirmedAt: clock.now(),
    })
    .returning();
  await db.insert(imageAssetFiles).values({
    assetId: asset!.id,
    pngBase64: "fixture",
    sha256: "c".repeat(64),
    width: 1,
    height: 1,
    byteSize: 1,
    uploadedBy: s.ops.userId,
  });
  const replacement = await s.publish(2, {
    snapshot: [
      {
        assetId: asset!.id,
        slot: "hero",
        label: "新しい外観",
        sha256: "c".repeat(64),
        policy: { allowedUses: ["production"] },
      },
    ],
  });
  await confirmPublicationMaterialCheck(db, clock, s.ops, {
    ...(await s.input()),
    outcome: "replaced",
    replacementId: replacement.dep.id,
  });
  await db.update(imageAssets).set({ allowProduction: false }).where(eq(imageAssets.id, asset!.id));
  const r = await s.listing();
  expect(r).toMatchObject({ pending: 1, resolved: 1 });
  expect(r.items.find((x) => x.version === 1)!.state).toBe("resolved");
  expect(r.items.find((x) => x.version === 2)!.state).toBe("pending");
});
it("運営だけが閲覧・確認でき、停止アカウントや偽の役割を拒否する", async () => {
  const s = await setup();
  await s.withdraw();
  const i = await s.input();
  for (const actor of [
    null,
    s.sales,
    { kind: "customer_user" as const, userId: s.sales.userId },
    { kind: "ops" as const, userId: s.sales.userId },
  ]) {
    await expect(listPublicationMaterials(db, actor)).rejects.toThrow();
    await expect(confirmPublicationMaterialCheck(db, clock, actor, i)).rejects.toThrow();
  }
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  await expect(s.listing()).rejects.toThrow("有効な運営");
  await expect(confirmPublicationMaterialCheck(db, clock, s.ops, i)).rejects.toThrow("有効な運営");
});
it("会社と状態の絞り込み、20件のページ分割を行う", async () => {
  const s = await setup();
  await s.withdraw();
  for (let v = 2; v <= 22; v++) await s.publish(v);
  const foreign = await setup();
  const r = await listPublicationMaterials(db, s.ops, { companyId: s.company.id, mode: "pending", page: 1 });
  expect(r.total).toBe(22);
  expect(r.items).toHaveLength(2);
  expect(r.items.every((x) => x.companyId === s.company.id)).toBe(true);
  expect(await listPublicationMaterials(db, s.ops, { companyId: foreign.company.id, mode: "pending" })).toMatchObject({
    total: 0,
  });
});
it("履歴の保存に失敗した場合、確認と受付番号も巻き戻す", async () => {
  const s = await setup();
  await s.withdraw();
  await db.execute(
    sql`CREATE FUNCTION fail_publication_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER fail_publication_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_publication_audit()`,
  );
  await expect(confirmPublicationMaterialCheck(db, clock, s.ops, await s.input())).rejects.toThrow();
  expect(await db.select().from(publicationMaterialChecks)).toHaveLength(0);
  expect(await db.select().from(publicationCheckOperations)).toHaveLength(0);
});
it("公開URLは認証情報を拒否しフラグメントだけを取り除く", () => {
  expect(publicationUrl("https://store.example.test/path?x=1#top")).toBe("https://store.example.test/path?x=1");
  expect(publicationUrl("https://user:pass@store.example.test")).toBeNull();
  expect(publicationUrl("javascript:alert(1)")).toBeNull();
});

it("対象1件の更新取得は一覧の状態に依存せず、有効な運営権限を確認する", async () => {
  const s = await setup();
  await s.withdraw();
  await confirmPublicationMaterialCheck(db, clock, s.ops, await s.input());
  expect((await listPublicationMaterials(db, s.ops)).items).toHaveLength(0);
  expect(await getPublicationMaterial(db, s.ops, s.first.dep.id)).toMatchObject({
    state: "resolved",
    check: { revision: 1 },
  });
  await expect(getPublicationMaterial(db, s.sales, s.first.dep.id)).rejects.toThrow("運営");
  await expect(getPublicationMaterial(db, s.ops, randomUUID())).rejects.toThrow("見つかりません");
});
it("URL未記録の旧版は実際の確認先を要求し、置き換えURLとも照合する", async () => {
  const s = await setup();
  await s.withdraw();
  await db.update(deployments).set({ url: null }).where(eq(deployments.id, s.first.dep.id));
  const next = await s.publish(2, { snapshot: [], url: "https://verified.example.test/" });
  const input = { ...(await s.input()), outcome: "replaced" as const, replacementId: next.dep.id };
  await expect(confirmPublicationMaterialCheck(db, clock, s.ops, input)).rejects.toThrow("同じ公開先");
  expect(
    await confirmPublicationMaterialCheck(db, clock, s.ops, {
      ...input,
      observedUrl: "https://verified.example.test/",
    }),
  ).toMatchObject({ item: { state: "resolved" } });
});
