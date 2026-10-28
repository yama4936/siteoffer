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
import { asc, desc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import { seedDeliveryBase } from "./delivery/test-helpers.ts";
import { recordCustomerImageRightsConsent } from "./image-rights-consent.ts";
import {
  confirmPublicationMaterialBatch,
  confirmPublicationMaterialCheck,
  getPublicationMaterial,
  getPublicationMaterialBatch,
  getPublicationMaterialWork,
  getPublicationReopenBatch,
  listPublicationMaterials,
  publicationUrl,
  reopenPublicationMaterialBatch,
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
it("同意記録のない旧版は運営の許可の停止を検出し、素材なしと追跡不能の旧版を区別する", async () => {
  const s = await setup();
  expect(await s.listing()).toMatchObject({ scanned: 1, pending: 0, items: [{ state: "clear" }] });
  await s.withdraw();
  expect(await s.listing()).toMatchObject({
    pending: 1,
    items: [{ issues: [{ reason: "顧客の画像の権利への同意がありません" }] }],
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
it("顧客の同意がある版は運営の許可を見ず、同意した画像の組と違えば要確認にする", async () => {
  const s = await setup();
  const consent = (images: { assetId: string; slot: string; sha256: string }[], at = clock) =>
    db.transaction((tx) =>
      recordCustomerImageRightsConsent(tx, at, {
        actor: { kind: "customer", shareLinkId: randomUUID() },
        companyId: s.company.id,
        deliveryId: s.delivery.id,
        versionId: s.first.version.id,
        version: 1,
        buildId: s.first.build.id,
        approvalId: randomUUID(),
        shareLinkId: randomUUID(),
        images: images.map((i) => ({ ...i, slot: i.slot as "hero", label: "x", policy: {} as never })),
      }),
    );
  await consent([{ assetId: s.asset.id, slot: "hero", sha256: "a".repeat(64) }]);
  await s.withdraw();
  expect(await s.listing()).toMatchObject({ pending: 0, items: [{ state: "clear" }] });
  await consent([{ assetId: s.asset.id, slot: "logo", sha256: "a".repeat(64) }], fixedClock("2026-10-18T00:00:00Z"));
  expect(await s.listing()).toMatchObject({
    pending: 1,
    items: [{ issues: [{ reason: "顧客が同意した画像と公開した画像が一致しません" }] }],
  });
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

async function batchFixture() {
  const s = await setup();
  await s.withdraw();
  await s.publish(2);
  await s.publish(3);
  const replacement = await s.publish(4, { snapshot: [] });
  const preview = await getPublicationMaterialBatch(db, s.ops, s.first.dep.id);
  const input = {
    deploymentId: preview.deploymentId,
    scope: preview.scope,
    items: preview.items.map((r) => ({
      deploymentId: r.deploymentId,
      revision: r.revision,
      fingerprint: r.fingerprint,
    })),
    requestId: randomUUID(),
    outcome: "replaced" as "replaced" | "site_offline",
    replacementId: replacement.dep.id as string | null,
    observedUrl: preview.url,
    note: "元の公開先で新しい承認版への置き換えが反映されたことを確認しました。",
    confirmed: true,
  };
  return { ...s, preview, input };
}
it("同じ公開先の旧版を一括で記録し、受付は1件、監査は対象ごとに残す", async () => {
  const s = await batchFixture(),
    r = await confirmPublicationMaterialBatch(db, clock, s.ops, s.input);
  expect(r.replayed).toBe(false);
  expect(r.items).toHaveLength(3);
  expect(r.items.every((x) => x.state === "resolved")).toBe(true);
  expect(await db.select().from(publicationCheckOperations)).toHaveLength(1);
  const audits = await db.select().from(auditEvents);
  expect(audits).toHaveLength(3);
  expect(audits.every((a) => (a.after as { batchRequestId: string }).batchRequestId === s.input.requestId)).toBe(true);
  expect(
    await confirmPublicationMaterialBatch(db, clock, s.ops, { ...s.input, items: [...s.input.items].reverse() }),
  ).toMatchObject({ replayed: true });
  await expect(
    confirmPublicationMaterialBatch(db, clock, s.ops, {
      ...s.input,
      note: "別の確認内容で受付番号を使い直そうとしました。",
    }),
  ).rejects.toThrow("同じ受付番号");
  const item = r.items[0]!;
  await reopenPublicationMaterialCheck(db, clock, s.ops, {
    deploymentId: item.deploymentId,
    revision: item.check!.revision,
    requestId: randomUUID(),
    note: "対象の版をもう一度確認する必要があるため再確認へ戻します。",
    confirmed: true,
  });
  const replay = await confirmPublicationMaterialBatch(db, clock, s.ops, s.input);
  expect(replay.items.find((x) => x.deploymentId === item.deploymentId)!.state).toBe("pending");
});
it("選択した一部だけを確認し、選ばなかった旧版は未対応のまま残す", async () => {
  const s = await batchFixture();
  const input = { ...s.input, items: s.input.items.slice(0, 2), outcome: "site_offline" as const, replacementId: null };
  await confirmPublicationMaterialBatch(db, clock, s.ops, input);
  expect(await s.listing()).toMatchObject({ pending: 1, resolved: 2 });
  expect(await db.select().from(deployments)).toHaveLength(4);
});
it("選択した1件だけが古くなった場合も全体を保存しない", async () => {
  const s = await batchFixture();
  const id = s.input.items.at(-1)!.deploymentId;
  const [dep] = await db.select().from(deployments).where(eq(deployments.id, id));
  const [version] = await db.select().from(deliveryVersions).where(eq(deliveryVersions.id, dep!.deliveryVersionId));
  await db.update(deliveryBuilds).set({ imageAssetSnapshot: null }).where(eq(deliveryBuilds.id, version!.buildId!));
  await expect(confirmPublicationMaterialBatch(db, clock, s.ops, s.input)).rejects.toThrow("変わりました");
  expect(await db.select().from(publicationMaterialChecks)).toHaveLength(0);
  expect(await db.select().from(publicationCheckOperations)).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
it("別URL・環境・納品や、記録のないURLはまとめない", async () => {
  const s = await batchFixture(),
    foreign = await setup();
  await foreign.withdraw();
  const otherUrl = await s.publish(5, { url: "https://other.example.test/" }),
    otherEnv = await s.publish(6, { env: "staging" }),
    noUrl = await s.publish(7, { url: null });
  const before = await getPublicationMaterialBatch(db, s.ops, s.first.dep.id);
  expect(before.total).toBe(3);
  for (const target of [otherUrl.dep, otherEnv.dep, foreign.first.dep, noUrl.dep]) {
    const item = await getPublicationMaterial(db, s.ops, target.id);
    await expect(
      confirmPublicationMaterialBatch(db, clock, s.ops, {
        ...s.input,
        items: [s.input.items[0]!, { deploymentId: item.deploymentId, revision: 0, fingerprint: item.fingerprint }],
      }),
    ).rejects.toThrow("同じ納品");
  }
  await expect(getPublicationMaterialBatch(db, s.ops, noUrl.dep.id)).rejects.toThrow("個別に確認");
  expect(await db.select().from(publicationMaterialChecks)).toHaveLength(0);
});
it("一括確認でも対象数・重複・範囲・確認チェックと権限を要求する", async () => {
  const s = await batchFixture();
  for (const patch of [
    { items: [] },
    { items: s.input.items.slice(0, 1) },
    { items: [s.input.items[0]!, s.input.items[0]!] },
    { items: Array.from({ length: 51 }, () => s.input.items[0]!) },
    { scope: "0".repeat(64) },
    { confirmed: false },
    { observedUrl: "https://different.example.test/" },
  ])
    await expect(confirmPublicationMaterialBatch(db, clock, s.ops, { ...s.input, ...patch })).rejects.toThrow();
  for (const actor of [null, s.sales, { kind: "ops" as const, userId: s.sales.userId }]) {
    await expect(getPublicationMaterialBatch(db, actor, s.first.dep.id)).rejects.toThrow();
    await expect(confirmPublicationMaterialBatch(db, clock, actor, s.input)).rejects.toThrow();
  }
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  await expect(confirmPublicationMaterialBatch(db, clock, s.ops, s.input)).rejects.toThrow("有効な運営");
});
it("一括保存の途中で監査が失敗しても、先に保存した確認を含め全件巻き戻す", async () => {
  const s = await batchFixture();
  await db.execute(
    sql`CREATE FUNCTION fail_later_publication_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT count(*) FROM audit_events)>0 THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER fail_later_publication_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_later_publication_audit()`,
  );
  await expect(confirmPublicationMaterialBatch(db, clock, s.ops, s.input)).rejects.toThrow();
  expect(await db.select().from(publicationMaterialChecks)).toHaveLength(0);
  expect(await db.select().from(publicationCheckOperations)).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
it("候補の最新承認版の利用許可を取り下げた場合も、一括確認を拒否する", async () => {
  const s = await batchFixture();
  await s.publish(5); // The latest target now contains the withdrawn asset.
  await expect(confirmPublicationMaterialBatch(db, clock, s.ops, s.input)).rejects.toThrow("新しい承認版");
  expect(await db.select().from(publicationMaterialChecks)).toHaveLength(0);
});
it("50件を超える場合は全体件数と表示上限を明示し、指定した旧版も候補に含める", async () => {
  const s = await setup();
  await s.withdraw();
  let last = s.first;
  for (let v = 2; v <= 52; v++) last = await s.publish(v);
  const p = await getPublicationMaterialBatch(db, s.ops, last.dep.id);
  expect(p.total).toBe(52);
  expect(p.limit).toBe(50);
  expect(p.items).toHaveLength(50);
  expect(p.items.some((x) => x.deploymentId === last.dep.id)).toBe(true);
  expect(new Set(p.items.map((x) => x.deploymentId)).size).toBe(50);
});

async function confirmedBatchFixture() {
  const s = await batchFixture();
  await confirmPublicationMaterialBatch(db, clock, s.ops, s.input);
  const preview = await getPublicationReopenBatch(db, s.ops, s.first.dep.id);
  return {
    ...s,
    reopenPreview: preview,
    reopenInput: {
      deploymentId: s.first.dep.id,
      scope: preview.scope,
      items: preview.items
        .filter((r) => r.eligible)
        .map((r) => ({ deploymentId: r.deploymentId, revision: r.revision })),
      requestId: randomUUID(),
      note: "公開先の確認に誤りがあったため、選択した確認記録を再確認へ戻します。",
      confirmed: true,
    },
  };
}
it("既存の一括監査から対象をたどり、別の運営担当者でも理由付きでまとめて再確認へ戻せる", async () => {
  const s = await confirmedBatchFixture(),
    peer = await setup();
  expect(s.reopenPreview.items).toHaveLength(3);
  expect(s.reopenPreview.items.every((r) => r.eligible)).toBe(true);
  expect(await getPublicationMaterial(db, s.ops, s.first.dep.id)).toMatchObject({
    relatedConfirmedBatch: 3,
    check: { batchRequestId: s.input.requestId },
  });
  expect(await db.select().from(auditEvents)).toHaveLength(3);
  const r = await reopenPublicationMaterialBatch(db, clock, peer.ops, s.reopenInput);
  expect(
    r.items.every((x) => x.state === "pending" && x.check?.revision === 2 && x.check.revokedBy === peer.ops.userId),
  ).toBe(true);
  expect(await db.select().from(publicationCheckOperations)).toHaveLength(2);
  const events = await db.select().from(auditEvents);
  expect(events).toHaveLength(6);
  expect(
    events
      .filter((e) => e.action === "publication_material.reopen")
      .every((e) => (e.after as { sourceBatchRequestId: string }).sourceBatchRequestId === s.input.requestId),
  ).toBe(true);
  expect(
    await reopenPublicationMaterialBatch(db, clock, peer.ops, {
      ...s.reopenInput,
      items: [...s.reopenInput.items].reverse(),
    }),
  ).toMatchObject({ replayed: true });
});
it("後から個別に確認し直した対象は履歴に表示するが、一括取り消しでは変更しない", async () => {
  const s = await confirmedBatchFixture(),
    item = s.reopenPreview.items[1]!;
  await reopenPublicationMaterialCheck(db, clock, s.ops, {
    deploymentId: item.deploymentId,
    revision: 1,
    requestId: randomUUID(),
    note: "この版だけ先に確認をやり直すことにしました。",
    confirmed: true,
  });
  const fresh = await getPublicationMaterial(db, s.ops, item.deploymentId);
  await confirmPublicationMaterialCheck(db, clock, s.ops, {
    deploymentId: item.deploymentId,
    revision: 2,
    fingerprint: fresh.fingerprint,
    requestId: randomUUID(),
    outcome: "site_offline",
    replacementId: null,
    observedUrl: s.input.observedUrl,
    note: "この版を個別に確認し直して公開停止を確認しました。",
    confirmed: true,
  });
  const p = await getPublicationReopenBatch(db, s.ops, s.first.dep.id);
  expect(p.items).toHaveLength(3);
  expect(p.items.filter((r) => r.eligible)).toHaveLength(2);
  expect(p.items.find((r) => r.deploymentId === item.deploymentId)!.reason).toContain("別の確認操作");
  await expect(reopenPublicationMaterialBatch(db, clock, s.ops, s.reopenInput)).rejects.toThrow("変わりました");
  await reopenPublicationMaterialBatch(db, clock, s.ops, {
    ...s.reopenInput,
    requestId: randomUUID(),
    items: p.items.filter((r) => r.eligible).map((r) => ({ deploymentId: r.deploymentId, revision: r.revision })),
  });
  expect(await getPublicationMaterial(db, s.ops, item.deploymentId)).toMatchObject({
    state: "resolved",
    check: { revision: 3, note: "この版を個別に確認し直して公開停止を確認しました。" },
  });
});
it("履歴の取得後に1件が再確認へ戻された場合、一括操作は残りも変更しない", async () => {
  const s = await confirmedBatchFixture(),
    item = s.reopenPreview.items[1]!;
  await reopenPublicationMaterialCheck(db, clock, s.ops, {
    deploymentId: item.deploymentId,
    revision: 1,
    requestId: randomUUID(),
    note: "別の担当者がこの版を先に再確認へ戻しました。",
    confirmed: true,
  });
  await expect(reopenPublicationMaterialBatch(db, clock, s.ops, s.reopenInput)).rejects.toThrow("変わりました");
  expect(await s.listing()).toMatchObject({ resolved: 2, pending: 1 });
  expect(await db.select().from(publicationCheckOperations)).toHaveLength(2);
});
it("同じ公開先でも別の一括確認は取り消し対象に混ぜず、同じ受付番号を使った別担当者とも混ぜない", async () => {
  const s = await confirmedBatchFixture();
  await s.publish(5);
  await s.publish(6);
  const next = await s.publish(7, { snapshot: [] });
  const p = await getPublicationMaterialBatch(
    db,
    s.ops,
    (await s.listing()).items.find((r) => r.version === 5)!.deploymentId,
  );
  const r = await confirmPublicationMaterialBatch(db, clock, s.ops, {
    ...s.input,
    deploymentId: p.deploymentId,
    scope: p.scope,
    items: p.items.map((i) => ({ deploymentId: i.deploymentId, revision: i.revision, fingerprint: i.fingerprint })),
    requestId: randomUUID(),
    replacementId: next.dep.id,
  });
  await expect(
    reopenPublicationMaterialBatch(db, clock, s.ops, {
      ...s.reopenInput,
      items: [s.reopenInput.items[0]!, { deploymentId: r.items[0]!.deploymentId, revision: 1 }],
    }),
  ).rejects.toThrow("変わりました");
  const other = await batchFixture();
  await confirmPublicationMaterialBatch(db, clock, other.ops, { ...other.input, requestId: s.input.requestId });
  expect((await getPublicationReopenBatch(db, s.ops, s.first.dep.id)).items).toHaveLength(3);
});
it("再確認への一括取り消しも、途中の監査失敗では全件を巻き戻す", async () => {
  const s = await confirmedBatchFixture();
  await db.execute(
    sql`CREATE FUNCTION fail_later_reopen_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='publication_material.reopen' AND (SELECT count(*) FROM audit_events WHERE action='publication_material.reopen')>0 THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER fail_later_reopen_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_later_reopen_audit()`,
  );
  await expect(reopenPublicationMaterialBatch(db, clock, s.ops, s.reopenInput)).rejects.toThrow();
  expect(await s.listing()).toMatchObject({ resolved: 3, pending: 0 });
  expect(await db.select().from(auditEvents)).toHaveLength(3);
  expect(await db.select().from(publicationCheckOperations)).toHaveLength(1);
});
it("取り消し後に新たに確認した記録は、古い取り消しの再送で再度戻さない", async () => {
  const s = await confirmedBatchFixture();
  const r = await reopenPublicationMaterialBatch(db, clock, s.ops, s.reopenInput),
    item = r.items[0]!;
  await confirmPublicationMaterialCheck(db, clock, s.ops, {
    deploymentId: item.deploymentId,
    revision: 2,
    fingerprint: item.fingerprint,
    requestId: randomUUID(),
    outcome: "site_offline",
    replacementId: null,
    observedUrl: s.input.observedUrl,
    note: "最新の確認で元サイトの公開停止が反映されたことを確認しました。",
    confirmed: true,
  });
  const replay = await reopenPublicationMaterialBatch(db, clock, s.ops, s.reopenInput);
  expect(replay.replayed).toBe(true);
  expect(replay.items.find((r) => r.deploymentId === item.deploymentId)).toMatchObject({
    state: "resolved",
    check: { revision: 3 },
  });
  expect(await db.select().from(auditEvents)).toHaveLength(7);
});
it("一括取り消しも理由・明示チェック・確認版・運営権限を要求する", async () => {
  const s = await confirmedBatchFixture();
  for (const patch of [
    { items: [] },
    { items: s.reopenInput.items.slice(0, 1) },
    { items: [s.reopenInput.items[0]!, s.reopenInput.items[0]!] },
    { scope: "0".repeat(64) },
    { confirmed: false },
    { note: "短い" },
    { requestId: s.input.requestId },
  ])
    await expect(reopenPublicationMaterialBatch(db, clock, s.ops, { ...s.reopenInput, ...patch })).rejects.toThrow();
  for (const actor of [null, s.sales, { kind: "ops" as const, userId: s.sales.userId }]) {
    await expect(getPublicationReopenBatch(db, actor, s.first.dep.id)).rejects.toThrow();
    await expect(reopenPublicationMaterialBatch(db, clock, actor, s.reopenInput)).rejects.toThrow();
  }
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  await expect(reopenPublicationMaterialBatch(db, clock, s.ops, s.reopenInput)).rejects.toThrow("有効な運営");
});
it("素材の問題が解消済みなら確認を取り消しても新しい対応待ちを作らない", async () => {
  const s = await confirmedBatchFixture();
  await db.update(imageAssets).set({ allowProduction: true }).where(eq(imageAssets.id, s.asset.id));
  const r = await reopenPublicationMaterialBatch(db, clock, s.ops, s.reopenInput);
  expect(r.items.every((i) => i.state === "clear" && i.check?.revokedAt !== null)).toBe(true);
  expect(await s.listing()).toMatchObject({ pending: 0, resolved: 0 });
});

it("元の一括受付と一致しない欠けた履歴では、残った記録だけを取り消さない", async () => {
  const s = await confirmedBatchFixture();
  const target = s.reopenPreview.items[1]!.deploymentId;
  await db.delete(auditEvents).where(eq(auditEvents.targetId, target));
  await expect(getPublicationReopenBatch(db, s.ops, s.first.dep.id)).rejects.toThrow("元の受付内容");
  await expect(reopenPublicationMaterialBatch(db, clock, s.ops, s.reopenInput)).rejects.toThrow("元の受付内容");
  expect(await s.listing()).toMatchObject({ resolved: 3, pending: 0 });
  expect(await db.select().from(publicationCheckOperations)).toHaveLength(1);
});

it("work detection matches the detailed detector for empty, malformed, foreign and reopened records", async () => {
  const s = await setup();
  await s.publish(2, { snapshot: [] });
  await s.publish(3, { snapshot: null });
  await s.publish(4, { snapshot: {} });
  await s.publish(5, {
    snapshot: [{ assetId: randomUUID(), slot: "hero", label: "missing", sha256: "b".repeat(64), policy: {} }],
  });
  await s.publish(6, {
    snapshot: [{ assetId: s.asset.id, slot: "hero", label: "mismatch", sha256: "b".repeat(64), policy: {} }],
  });
  const unknown = await s.publish(7, { snapshot: null });
  await s.publish(8, { snapshot: [] });
  const foreign = await seedDeliveryBase(db);
  const [otherDelivery] = await db.insert(deliveries).values({ contractId: foreign.contract.id }).returning();
  // Even an empty snapshot must be checked when a version belongs to another delivery.
  await db.update(deliveryVersions).set({ deliveryId: otherDelivery!.id }).where(eq(deliveryVersions.version, 8));
  const resolved = await s.publish(9, { snapshot: null });
  const reopened = await s.publish(10, { snapshot: null });
  for (const [r, revokedAt] of [
    [resolved, null],
    [reopened, clock.now()],
  ] as const)
    await db.insert(publicationMaterialChecks).values({
      deploymentId: r.dep.id,
      revision: 1,
      fingerprint: "a".repeat(64),
      outcome: "site_offline",
      observedUrl: "https://store.example.test/",
      note: "内部だけで保持する確認メモです。",
      checkedBy: s.ops.userId,
      checkedAt: clock.now(),
      revokedAt,
    });
  await db.update(deployments).set({ status: "failed" }).where(eq(deployments.id, unknown.dep.id));
  const detailed = await listPublicationMaterials(db, s.ops, { mode: "pending" });
  const work = await getPublicationMaterialWork(db, s.ops);
  expect(work.total).toBe(detailed.pending);
  expect(work.items.map((r) => r.id).sort()).toEqual(detailed.items.map((r) => r.deploymentId).sort());
  for (const item of work.items)
    expect(item.reason).toBe(detailed.items.find((r) => r.deploymentId === item.id)!.issues[0]!.reason);
  expect(work.items.some((r) => r.id === resolved.dep.id)).toBe(false);
  expect(work.items.some((r) => r.id === reopened.dep.id)).toBe(true);
  expect(JSON.stringify(work)).not.toContain("内部だけで保持する確認メモ");
  expect(JSON.stringify(work)).not.toContain("fingerprint");
});

it("work detection counts every candidate across 500-row windows and timestamp ties", async () => {
  const s = await setup();
  const legacy = await s.publish(2, { snapshot: null });
  for (const [kind, n, versionId] of [
    ["clear", 501, s.first.version.id],
    ["pending", 1201, legacy.version.id],
  ] as const)
    await db.execute(sql`insert into deployments(id,delivery_id,delivery_version_id,environment,url,status,created_at)
      select md5(${kind}||g::text)::uuid,${s.delivery.id}::uuid,${versionId}::uuid,'production','https://window.example.test/','recorded',timestamptz '2026-10-01'
      from generate_series(1,${n}) g`);
  const [lastById] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(eq(deployments.deliveryVersionId, legacy.version.id))
    .orderBy(desc(deployments.id))
    .limit(1);
  await db
    .update(deployments)
    .set({ createdAt: new Date("2026-09-01T00:00:00Z") })
    .where(eq(deployments.id, lastById!.id));
  const expected = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(eq(deployments.deliveryVersionId, legacy.version.id))
    .orderBy(asc(deployments.createdAt), asc(deployments.id))
    .limit(20);
  const work = await getPublicationMaterialWork(db, s.ops);
  expect(work.total).toBe(1202);
  expect(work.items.map((r) => r.id)).toEqual(expected.map((r) => r.id));
  expect(work.items[0]!.id).toBe(lastById!.id);
  expect(new Set(work.items.map((r) => r.id)).size).toBe(20);
  await db.update(imageAssets).set({ allowProduction: false }).where(eq(imageAssets.id, s.asset.id));
  // Previously clean, nonempty snapshots are reconsidered using current policy.
  expect((await getPublicationMaterialWork(db, s.ops)).total).toBe(1704);
});

it("detail pagination retains complete counts and full notes only for the requested records", async () => {
  const s = await setup();
  await db.execute(sql`insert into deployments(id,delivery_id,delivery_version_id,environment,url,status,created_at)
    select md5('detail'||g::text)::uuid,${s.delivery.id}::uuid,${s.first.version.id}::uuid,'production','https://store.example.test/','recorded',timestamptz '2026-10-01' from generate_series(1,5501) g`);
  await db.execute(sql`insert into publication_material_checks(deployment_id,revision,fingerprint,outcome,observed_url,note,checked_by,checked_at)
    select id,1,repeat('a',64),'site_offline',url,repeat('確認メモ',400),${s.ops.userId}::uuid,timestamptz '2026-10-16' from deployments where id<>${s.first.dep.id}::uuid`);
  const list = await listPublicationMaterials(db, s.ops, { deliveryId: s.delivery.id, mode: "all", page: 1 });
  expect(list).toMatchObject({ total: 5502, scanned: 5502, pending: 0, resolved: 5501 });
  expect(list.items).toHaveLength(20);
  expect(list.items.every((r) => r.check?.note === "確認メモ".repeat(400))).toBe(true);
  const one = await getPublicationMaterial(db, s.ops, list.items[0]!.deploymentId);
  expect(one).toEqual(list.items[0]);
  expect(
    await listPublicationMaterials(db, s.ops, { deliveryId: s.delivery.id, mode: "all", page: 100000 }),
  ).toMatchObject({ total: 5502, items: [] });
});

it("detail counts and historical batch links include members beyond the current page", async () => {
  const s = await setup();
  await s.withdraw();
  await db.execute(sql`insert into deployments(id,delivery_id,delivery_version_id,environment,url,status,created_at)
    select md5('batch-detail'||g::text)::uuid,${s.delivery.id}::uuid,${s.first.version.id}::uuid,'production','https://store.example.test/','recorded',timestamptz '2026-10-01' from generate_series(1,25) g`);
  const preview = await getPublicationMaterialBatch(db, s.ops, s.first.dep.id);
  expect(preview.total).toBe(26);
  const note = "公開先全体を停止したことを確認しました。";
  await confirmPublicationMaterialBatch(db, clock, s.ops, {
    deploymentId: s.first.dep.id,
    scope: preview.scope,
    items: preview.items.map((r) => ({
      deploymentId: r.deploymentId,
      revision: r.revision,
      fingerprint: r.fingerprint,
    })),
    requestId: randomUUID(),
    outcome: "site_offline",
    replacementId: null,
    observedUrl: preview.url,
    note,
    confirmed: true,
  });
  const focused = await listPublicationMaterials(db, s.ops, { deploymentId: s.first.dep.id, mode: "all" });
  expect(focused).toMatchObject({ scanned: 1, resolved: 1, items: [{ relatedConfirmedBatch: 26, check: { note } }] });
  const other = (await listPublicationMaterials(db, s.ops, { deliveryId: s.delivery.id, mode: "all", page: 1 }))
    .items[0]!;
  await reopenPublicationMaterialCheck(db, clock, s.ops, {
    deploymentId: other.deploymentId,
    revision: other.check!.revision,
    requestId: randomUUID(),
    note: "この記録は個別の確認で進めるため取り消します。",
    confirmed: true,
  });
  const current = await getPublicationMaterial(db, s.ops, other.deploymentId);
  await confirmPublicationMaterialCheck(db, clock, s.ops, {
    deploymentId: current.deploymentId,
    revision: current.check!.revision,
    fingerprint: current.fingerprint,
    requestId: randomUUID(),
    outcome: "site_offline",
    replacementId: null,
    observedUrl: preview.url,
    note: "個別に公開先の停止を確認し直しました。",
    confirmed: true,
  });
  expect((await getPublicationMaterial(db, s.ops, s.first.dep.id)).relatedConfirmedBatch).toBe(25);
  const history = await getPublicationReopenBatch(db, s.ops, s.first.dep.id);
  expect(history.items).toHaveLength(26);
  expect(history.items.filter((r) => r.eligible)).toHaveLength(25);
  expect(history.items.find((r) => r.deploymentId === other.deploymentId)?.eligible).toBe(false);
});

it("detail ordering preserves PostgreSQL microseconds before version order", async () => {
  const s = await setup(),
    older = await s.publish(3, { snapshot: [] }),
    newer = await s.publish(2, { snapshot: [] });
  await db.execute(
    sql`update deployments set created_at=timestamptz '2026-10-18T00:00:00.000001Z' where id=${older.dep.id}::uuid`,
  );
  await db.execute(
    sql`update deployments set created_at=timestamptz '2026-10-18T00:00:00.000002Z' where id=${newer.dep.id}::uuid`,
  );
  const list = await s.listing();
  expect(list.items.slice(0, 2).map((r) => r.deploymentId)).toEqual([newer.dep.id, older.dep.id]);
  expect(list.items[0]!.createdAt).toBe(list.items[1]!.createdAt);
  await s.withdraw();
  expect((await getPublicationMaterial(db, s.ops, s.first.dep.id)).replacements.map((r) => r.deploymentId)).toEqual([
    newer.dep.id,
  ]);
});
