import { randomUUID } from "node:crypto";
import {
  confirmPublicationMaterialCheck,
  fixedClock,
  getPublicationMaterial,
  getPublicationMaterialWork,
  listImageSubmissionsForOps,
  listPublicationMaterials,
} from "@siteoffer/core";
import { seedDeliveryBase } from "@siteoffer/core/delivery/testing";
import {
  approvals,
  companies,
  type Db,
  deliveries,
  deliveryBuilds,
  deliveryVersions,
  deployments,
  imageAssetFiles,
  imageAssets,
  imageSubmissions,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getOpsWorkQueue } from "./work-queue";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
async function fixture() {
  const b = await seedDeliveryBase(db);
  const [delivery] = await db.insert(deliveries).values({ contractId: b.contract.id, status: "delivered" }).returning();
  const [customer] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.test`,
      displayName: "架空提出者",
      role: "customer",
      passwordHash: "unused",
    })
    .returning();
  async function material(index: number, status: "pending" | "accepted" | "withdrawn" | "needs_changes" = "pending") {
    const [a] = await db
      .insert(imageAssets)
      .values({ companyId: b.company.id, label: `店舗写真${index}`, sourceType: "customer_upload" })
      .returning();
    await db.insert(imageAssetFiles).values({
      assetId: a!.id,
      pngBase64: "private-image-fixture",
      sha256: "a".repeat(64),
      width: 1,
      height: 1,
      byteSize: 1,
      uploadedBy: b.ops.userId,
    });
    await db.insert(imageSubmissions).values({
      assetId: a!.id,
      submittedBy: customer!.id,
      status,
      rightsBasis: "own_work",
      rightsNote: "private-rights-fixture",
      requestedDemo: false,
      requestedProduction: true,
      updatedAt: new Date(Date.UTC(2026, 9, index + 1)),
      submittedAt: new Date(Date.UTC(2026, 9, index + 1)),
    });
    return a!;
  }
  async function publication(index: number, snapshot: unknown = null) {
    const [build] = await db
      .insert(deliveryBuilds)
      .values({ deliveryId: delivery!.id, status: "succeeded", imageAssetSnapshot: snapshot })
      .returning();
    const [version] = await db
      .insert(deliveryVersions)
      .values({ deliveryId: delivery!.id, buildId: build!.id, version: index })
      .returning();
    await db.insert(approvals).values({ deliveryVersionId: version!.id, decision: "approved", decidedAt: clock.now() });
    const [record] = await db
      .insert(deployments)
      .values({
        deliveryId: delivery!.id,
        deliveryVersionId: version!.id,
        status: "recorded",
        environment: "production",
        url: "https://fixture.example.test/",
        createdAt: new Date(Date.UTC(2026, 8, index)),
      })
      .returning();
    return record!;
  }
  async function queue() {
    const r = await getOpsWorkQueue(db, b.ops, clock);
    if (!r.ok) throw Error("queue denied");
    return r.value;
  }
  return { ...b, material, publication, queue, delivery: delivery! };
}
it("素材確認は全件数と古い20件を返し、ページ外の対象へ直接進める", async () => {
  const f = await fixture(),
    ids: string[] = [];
  for (let i = 0; i < 24; i++) ids.push((await f.material(i)).id);
  await f.material(25, "needs_changes");
  await f.material(26, "accepted");
  await f.material(27, "withdrawn");
  const q = await f.queue(),
    items = q.items.filter((r) => r.group === "materials");
  expect(q.groups.find((g) => g.key === "materials")!.count).toBe(24);
  expect(items.map((i) => i.id)).toEqual(ids.slice(0, 20));
  expect(JSON.stringify(q)).not.toContain("private-image-fixture");
  expect(JSON.stringify(q)).not.toContain("private-rights-fixture");
  const link = new URL(items[0]!.href, "http://localhost");
  expect(link.searchParams.get("focus")).toBe(ids[0]);
  const exact = await listImageSubmissionsForOps(db, f.ops, {
    companyId: f.company.id,
    assetId: ids[0],
    pendingOnly: false,
  });
  expect(exact.total).toBe(1);
  expect(exact.items[0]!.assetId).toBe(ids[0]);
  const other = await fixture();
  expect(
    (await listImageSubmissionsForOps(db, f.ops, { companyId: other.company.id, assetId: ids[0] })).items,
  ).toHaveLength(0);
  await expect(listImageSubmissionsForOps(db, f.ops, { assetId: "bad" })).rejects.toThrow("画像");
  await db.update(imageSubmissions).set({ status: "accepted" }).where(eq(imageSubmissions.assetId, ids[0]!));
  expect((await f.queue()).groups.find((g) => g.key === "materials")!.count).toBe(23);
  await db.update(companies).set({ suppression: "do_not_contact" }).where(eq(companies.id, f.company.id));
  expect((await f.queue()).items.some((i) => i.group === "materials")).toBe(true);
});
it("公開後の問題も古い20件と全件数を返し、処理停止と区別して優先表示する", async () => {
  const f = await fixture();
  await f.material(0);
  const ids: string[] = [];
  for (let i = 1; i <= 24; i++) ids.push((await f.publication(i)).id);
  const clean = await f.publication(25, []);
  const w = await getPublicationMaterialWork(db, f.ops);
  expect(w.total).toBe(24);
  expect(w.items.map((i) => i.id)).toEqual(ids.slice(0, 20));
  const q = await f.queue(),
    p = q.items.filter((i) => i.group === "publication_materials");
  expect(q.groups.find((g) => g.key === "publication_materials")!.count).toBe(24);
  expect(p[0]).toMatchObject({ priority: 0, attentionLabel: "公開後の確認" });
  expect(q.items.indexOf(p[0]!)).toBeLessThan(q.items.findIndex((i) => i.group === "materials"));
  const focused = await listPublicationMaterials(db, f.ops, {
    deliveryId: f.delivery.id,
    deploymentId: ids[0],
    mode: "all",
  });
  expect(focused.total).toBe(1);
  expect(focused.items[0]!.replacements.map((i) => i.deploymentId)).toEqual([clean.id]);
  const item = await getPublicationMaterial(db, f.ops, ids[0]!);
  await confirmPublicationMaterialCheck(db, clock, f.ops, {
    deploymentId: item.deploymentId,
    fingerprint: item.fingerprint,
    revision: 0,
    requestId: randomUUID(),
    outcome: "replaced",
    replacementId: clean.id,
    observedUrl: "https://fixture.example.test/",
    note: "元の公開先を新しい承認版に置き換えたことを確認しました。",
    confirmed: true,
  });
  const next = await f.queue();
  expect(next.groups.find((g) => g.key === "publication_materials")!.count).toBe(23);
  expect(next.items.some((i) => i.id === ids[0])).toBe(false);
  expect((await getPublicationMaterialWork(db, f.ops)).items.at(-1)!.id).toBe(ids[20]);
});
it("新しい要約と対象絞り込みも、有効な運営だけに返す", async () => {
  const f = await fixture();
  const a = await f.material(0),
    p = await f.publication(1);
  for (const actor of [null, f.sales, { kind: "ops" as const, userId: f.sales.userId }]) {
    await expect(getPublicationMaterialWork(db, actor)).rejects.toThrow();
    await expect(listImageSubmissionsForOps(db, actor, { assetId: a.id })).rejects.toThrow();
    await expect(listPublicationMaterials(db, actor, { deploymentId: p.id })).rejects.toThrow();
  }
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, f.ops.userId));
  expect(await getOpsWorkQueue(db, f.ops)).toMatchObject({ ok: false, error: "forbidden" });
  await expect(getPublicationMaterialWork(db, f.ops)).rejects.toThrow("有効な運営");
});
