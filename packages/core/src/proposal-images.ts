import { createHash } from "node:crypto";
import { type DbOrTx, imageAssetFiles, imageAssets, proposals, proposalVersions } from "@siteoffer/db";
import { type ImagePolicy, imagePolicySchema } from "@siteoffer/schemas";
import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { ImageAssetError } from "./image-assets.ts";

export interface ProposalImageAsset {
  assetId: string;
  slot: "hero" | "logo";
  sha256: string;
  label: string;
  policyRevision: number;
  policy: ImagePolicy;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Existing proposals without a snapshot keep their original image-free output. */
export function parseProposalImageSnapshot(raw: unknown): ProposalImageAsset[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 2) return null;
  const result: ProposalImageAsset[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") return null;
    const a = value as Partial<ProposalImageAsset>;
    const policy = imagePolicySchema.safeParse(a.policy);
    if (
      !uuid.test(a.assetId ?? "") ||
      !/^[a-f0-9]{64}$/.test(a.sha256 ?? "") ||
      (a.slot !== "hero" && a.slot !== "logo") ||
      typeof a.label !== "string" ||
      !a.label.trim() ||
      !Number.isSafeInteger(a.policyRevision) ||
      a.policyRevision! < 0 ||
      !policy.success ||
      policy.data.rightsStatus === "unknown" ||
      !policy.data.confirmedBy ||
      !policy.data.confirmedAt ||
      policy.data.allowedUses.length !== 1 ||
      policy.data.allowedUses[0] !== "sales_demo"
    )
      return null;
    result.push({
      assetId: a.assetId!,
      slot: a.slot,
      sha256: a.sha256!,
      label: a.label,
      policyRevision: a.policyRevision!,
      policy: policy.data,
    });
  }
  if (
    new Set(result.map((a) => a.assetId)).size !== result.length ||
    new Set(result.map((a) => a.slot)).size !== result.length
  )
    return null;
  return result;
}
/** Worker-only. Capture in the proposal's ownership transaction before generation. */
export async function captureProposalImageAssets(tx: DbOrTx, companyId: string): Promise<ProposalImageAsset[]> {
  const rows = await tx
    .select({ asset: imageAssets, sha256: imageAssetFiles.sha256 })
    .from(imageAssets)
    .innerJoin(imageAssetFiles, eq(imageAssetFiles.assetId, imageAssets.id))
    .where(
      and(
        eq(imageAssets.companyId, companyId),
        ne(imageAssets.placement, "reference"),
        eq(imageAssets.allowSalesDemo, true),
        ne(imageAssets.rightsStatus, "unknown"),
        isNotNull(imageAssets.confirmedBy),
        isNotNull(imageAssets.confirmedAt),
      ),
    )
    .orderBy(asc(imageAssets.id))
    .for("share");
  const snapshot = rows.map(({ asset: a, sha256 }) => ({
    assetId: a.id,
    slot: a.placement as "hero" | "logo",
    sha256,
    label: a.label,
    policyRevision: a.policyRevision,
    policy: {
      sourceType: a.sourceType,
      sourceUrl: a.sourceUrl,
      rightsStatus: a.rightsStatus,
      allowedUses: ["sales_demo"] as ["sales_demo"],
      confirmedBy: a.confirmedBy,
      confirmedAt: a.confirmedAt!.toISOString(),
      note: a.note,
    },
  }));
  const parsed = parseProposalImageSnapshot(snapshot);
  if (!parsed) throw new ImageAssetError("提案素材の登録内容を確認してください");
  return parsed;
}
async function snapshotValid(db: DbOrTx, companyId: string, snapshot: ProposalImageAsset[]) {
  for (const s of snapshot) {
    const [row] = await db
      .select({ asset: imageAssets, sha256: imageAssetFiles.sha256 })
      .from(imageAssets)
      .innerJoin(imageAssetFiles, eq(imageAssetFiles.assetId, imageAssets.id))
      .where(and(eq(imageAssets.id, s.assetId), eq(imageAssets.companyId, companyId)));
    const a = row?.asset;
    if (
      !a?.allowSalesDemo ||
      a.rightsStatus === "unknown" ||
      !a.confirmedBy ||
      !a.confirmedAt ||
      a.policyRevision !== s.policyRevision ||
      a.placement !== s.slot ||
      row?.sha256 !== s.sha256
    )
      return false;
  }
  return true;
}
/** Check on every shared page and asset request, including links created before a permission change. */
export async function proposalVersionImagesValid(db: DbOrTx, versionId: string) {
  const [row] = await db
    .select({
      companyId: proposals.companyId,
      snapshot: sql<unknown>`${proposalVersions.content}->'demoImageAssets'`,
      hasSnapshot: sql<boolean>`coalesce(${proposalVersions.content} ? 'demoImageAssets', false)`,
    })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .where(eq(proposalVersions.id, versionId));
  if (!row) return false;
  const snapshot = parseProposalImageSnapshot(row.hasSnapshot ? row.snapshot : undefined);
  return snapshot !== null && snapshotValid(db, row.companyId, snapshot);
}
/** Files and permission revisions must still match the captured proposal. Never replace with a newly selected image. */
export async function loadProposalImageAssets(db: DbOrTx, companyId: string, raw: unknown) {
  const snapshot = parseProposalImageSnapshot(raw);
  if (!snapshot || !(await snapshotValid(db, companyId, snapshot)))
    throw new ImageAssetError("提案素材の許諾・配置が変更されています。素材を確認して新しい提案を制作してください");
  const result = [];
  for (const a of snapshot) {
    const [file] = await db.select().from(imageAssetFiles).where(eq(imageAssetFiles.assetId, a.assetId));
    if (!file || file.byteSize > 8 * 1024 * 1024 || file.pngBase64.length > 12 * 1024 * 1024)
      throw new ImageAssetError("提案素材のファイルを確認できません");
    const bytes = Buffer.from(file.pngBase64, "base64");
    if (bytes.length !== file.byteSize || createHash("sha256").update(bytes).digest("hex") !== a.sha256)
      throw new ImageAssetError("提案素材の整合性を確認できません");
    result.push({ ...a, bytes });
  }
  return result;
}
