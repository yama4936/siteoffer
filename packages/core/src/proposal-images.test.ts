import { randomUUID } from "node:crypto";
import { type Db, imageAssetFiles, imageAssets, proposalVersions } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import { attachImageAssetFile } from "./image-assets.ts";
import {
  captureProposalImageAssets,
  loadProposalImageAssets,
  parseProposalImageSnapshot,
  proposalVersionImagesValid,
} from "./proposal-images.ts";
import { issueShareLink, verifyShareLink } from "./share-link/share-link.ts";
import { seedCompany, seedProposalVersion, seedUser } from "./share-link/test-helpers.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-18T11:00:00Z");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUyNvCwMDAxMDAwMDAAAAOrgFGyLjQ8AAAAABJRU5ErkJggg==",
  "base64",
);
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
async function seed() {
  const { actor } = await seedUser(db, "ops");
  if (actor.kind !== "ops") throw new Error("Expected fixture operator");
  const company = await seedCompany(db);
  const [asset] = await db
    .insert(imageAssets)
    .values({
      companyId: company.id,
      label: "概念写真（実際の施工実績ではありません）",
      sourceType: "generated",
      placement: "hero",
    })
    .returning();
  await attachImageAssetFile(db, clock, actor, { companyId: company.id, assetId: asset!.id, png, width: 2, height: 2 });
  await db
    .update(imageAssets)
    .set({ rightsStatus: "use_approved", allowSalesDemo: true, confirmedBy: actor.userId!, confirmedAt: clock.now() })
    .where(eq(imageAssets.id, asset!.id));
  const snapshot = await db.transaction((tx) => captureProposalImageAssets(tx, company.id));
  const version = await seedProposalVersion(db, company.id, { artifactDir: "/fixture/demo" });
  await db
    .update(proposalVersions)
    .set({ content: { demoImageAssets: snapshot } })
    .where(eq(proposalVersions.id, version.id));
  return { actor, company, asset: asset!, snapshot, version };
}
it("captures only same-company, permitted, placed images with files, and never broadens to production", async () => {
  const s = await seed();
  await db.insert(imageAssets).values([
    {
      companyId: s.company.id,
      label: "内部参照",
      sourceType: "operator_upload",
      placement: "reference",
      allowSalesDemo: true,
      rightsStatus: "use_approved",
      confirmedBy: s.actor.userId!,
      confirmedAt: clock.now(),
    },
    {
      companyId: s.company.id,
      label: "未確認ロゴ",
      sourceType: "operator_upload",
      placement: "logo",
      allowSalesDemo: true,
    },
  ]);
  const other = await seedCompany(db);
  await db.insert(imageAssets).values({
    companyId: other.id,
    label: "別会社の画像",
    sourceType: "customer_upload",
    placement: "hero",
    allowSalesDemo: true,
    rightsStatus: "use_approved",
    confirmedBy: s.actor.userId!,
    confirmedAt: clock.now(),
  });
  expect(await db.transaction((tx) => captureProposalImageAssets(tx, s.company.id))).toEqual(s.snapshot);
  expect(s.snapshot).toMatchObject([
    { assetId: s.asset.id, slot: "hero", policyRevision: 1, policy: { allowedUses: ["sales_demo"] } },
  ]);
  expect((await loadProposalImageAssets(db, s.company.id, s.snapshot))[0]!.bytes).toEqual(png);
  expect(await proposalVersionImagesValid(db, s.version.id)).toBe(true);
  await expect(loadProposalImageAssets(db, other.id, s.snapshot)).rejects.toThrow("許諾");
});
it.each(["unknown", "production-only", "missing-review", "missing-file"])(
  "does not capture %s materials",
  async (mode) => {
    const s = await seed();
    if (mode === "missing-file") await db.delete(imageAssetFiles).where(eq(imageAssetFiles.assetId, s.asset.id));
    else
      await db
        .update(imageAssets)
        .set(
          mode === "unknown"
            ? { rightsStatus: "unknown" }
            : mode === "production-only"
              ? { allowSalesDemo: false, allowProduction: true }
              : { confirmedAt: null },
        )
        .where(eq(imageAssets.id, s.asset.id));
    expect(await db.transaction((tx) => captureProposalImageAssets(tx, s.company.id))).toEqual([]);
    expect(await proposalVersionImagesValid(db, s.version.id)).toBe(false);
  },
);
it.each(["permission", "revision", "placement", "hash"])(
  "invalidates an existing shared link when %s changes",
  async (change) => {
    const s = await seed();
    const link = await issueShareLink(db, clock, s.actor, { purpose: "proposal", targetId: s.version.id });
    expect(link.ok).toBe(true);
    if (!link.ok) throw new Error(link.error);
    expect((await verifyShareLink(db, clock, link.value.token)).ok).toBe(true);
    if (change === "hash")
      await db
        .update(imageAssetFiles)
        .set({ sha256: "f".repeat(64) })
        .where(eq(imageAssetFiles.assetId, s.asset.id));
    else
      await db
        .update(imageAssets)
        .set(
          change === "permission"
            ? { allowSalesDemo: false }
            : change === "revision"
              ? { policyRevision: 2 }
              : { placement: "reference" },
        )
        .where(eq(imageAssets.id, s.asset.id));
    expect((await verifyShareLink(db, clock, link.value.token)).ok).toBe(false);
    expect((await issueShareLink(db, clock, s.actor, { purpose: "proposal", targetId: s.version.id })).ok).toBe(false);
    await expect(loadProposalImageAssets(db, s.company.id, s.snapshot)).rejects.toThrow("許諾");
  },
);
it("rejects damaged bytes and byte lengths even with matching metadata", async () => {
  const s = await seed();
  await db
    .update(imageAssetFiles)
    .set({ pngBase64: Buffer.from("damaged").toString("base64") })
    .where(eq(imageAssetFiles.assetId, s.asset.id));
  await expect(loadProposalImageAssets(db, s.company.id, s.snapshot)).rejects.toThrow("整合性");
  await db
    .update(imageAssetFiles)
    .set({ pngBase64: Buffer.alloc(png.length).toString("base64") })
    .where(eq(imageAssetFiles.assetId, s.asset.id));
  await expect(loadProposalImageAssets(db, s.company.id, s.snapshot)).rejects.toThrow("整合性");
});
it("keeps old image-free versions unchanged and rejects malformed snapshots", async () => {
  const s = await seed();
  await db.update(proposalVersions).set({ content: {} }).where(eq(proposalVersions.id, s.version.id));
  expect(await proposalVersionImagesValid(db, s.version.id)).toBe(true);
  expect(await loadProposalImageAssets(db, s.company.id, undefined)).toEqual([]);
  for (const raw of [
    null,
    {},
    [...s.snapshot, ...s.snapshot],
    [{ ...s.snapshot[0], assetId: "../x" }],
    [{ ...s.snapshot[0], policyRevision: -1 }],
    [{ ...s.snapshot[0], policy: { ...s.snapshot[0]!.policy, allowedUses: ["production"] } }],
  ]) {
    expect(parseProposalImageSnapshot(raw)).toBeNull();
    await db
      .update(proposalVersions)
      .set({ content: { demoImageAssets: raw } })
      .where(eq(proposalVersions.id, s.version.id));
    expect(await proposalVersionImagesValid(db, s.version.id)).toBe(false);
  }
  expect(await proposalVersionImagesValid(db, randomUUID())).toBe(false);
});
