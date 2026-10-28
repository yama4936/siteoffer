import { createHash } from "node:crypto";
import {
  contracts,
  type DbOrTx,
  deliveries,
  deliveryBuilds,
  deliveryVersions,
  imageAssetFiles,
  imageAssets,
  imageSubmissions,
  users,
} from "@siteoffer/db";
import type { ImagePolicy } from "@siteoffer/schemas";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Actor } from "./common/actor.ts";
import type { Clock } from "./common/clock.ts";
import { recordEvent } from "./common/events.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class ImageAssetError extends Error {}
export async function requireAssetOperator(db: DbOrTx, actor: Actor | null, lock = false) {
  if (actor?.kind !== "ops" || !uuid.test(actor.userId)) throw new ImageAssetError("運営としてログインしてください");
  const query = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  const [u] = await (lock ? query.for("share") : query);
  if (!u) throw new ImageAssetError("運営としてログインしてください");
  return actor;
}
/** 正規化済みPNGを固定保存する。初回取込は実ファイルの許諾を再確認する。 */
export async function attachImageAssetFile(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: { companyId: string; assetId: string; png: Buffer; width: number; height: number },
) {
  await requireAssetOperator(db, actor);
  if (!uuid.test(input.assetId) || !uuid.test(input.companyId))
    throw new ImageAssetError("対象の素材を確認してください");
  const { png, width, height } = input;
  validateNormalizedAssetImage(input);
  const sha256 = createHash("sha256").update(png).digest("hex");
  return db.transaction(async (tx) => {
    const [asset] = await tx
      .select()
      .from(imageAssets)
      .where(and(eq(imageAssets.id, input.assetId), eq(imageAssets.companyId, input.companyId)))
      .for("update");
    if (!asset) throw new ImageAssetError("対象の素材が見つかりません");
    const ops = await requireAssetOperator(tx, actor, true);
    const [previous] = await tx
      .select({ sha256: imageAssetFiles.sha256 })
      .from(imageAssetFiles)
      .where(eq(imageAssetFiles.assetId, asset.id));
    if (previous) {
      if (previous.sha256 === sha256) return { sha256, alreadyStored: true };
      throw new ImageAssetError("登録済みの画像は差し替えできません。別の素材として登録してください");
    }
    await tx.insert(imageAssetFiles).values({
      assetId: asset.id,
      pngBase64: png.toString("base64"),
      sha256,
      width,
      height,
      byteSize: png.length,
      uploadedBy: ops.userId,
      uploadedAt: clock.now(),
    });
    await tx
      .update(imageAssets)
      .set({
        policyRevision: asset.policyRevision + 1,
        rightsStatus: "unknown",
        allowSalesDemo: false,
        allowProduction: false,
        confirmedBy: null,
        confirmedAt: null,
        updatedAt: clock.now(),
      })
      .where(eq(imageAssets.id, asset.id));
    await recordEvent(tx, clock, {
      actor: ops,
      action: "image_asset.file_attach",
      targetType: "company",
      targetId: asset.companyId,
      before: {
        imageAssetId: asset.id,
        rightsStatus: asset.rightsStatus,
        allowSalesDemo: asset.allowSalesDemo,
        allowProduction: asset.allowProduction,
      },
      after: { imageAssetId: asset.id, sha256, width, height, byteSize: png.length, rightsStatus: "unknown" },
    });
    return { sha256, alreadyStored: false };
  });
}
export async function getImageAssetFile(db: DbOrTx, actor: Actor | null, assetId: string) {
  await requireAssetOperator(db, actor);
  if (!uuid.test(assetId)) return null;
  const [file] = await db.select().from(imageAssetFiles).where(eq(imageAssetFiles.assetId, assetId));
  if (!file) return null;
  const bytes = Buffer.from(file.pngBase64, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) return null;
  return { bytes, sha256: file.sha256, width: file.width, height: file.height };
}
export type DeliveryImageAsset = {
  assetId: string;
  slot: "hero" | "logo";
  sha256: string;
  label: string;
  policy: ImagePolicy;
};
/** 生成に渡す利用方針の確認者。運営の許諾ではなく、納品承認時の顧客同意で本番利用を確定することを表す。 */
export const CUSTOMER_CONSENT_CONFIRMER = "customer_consent_at_delivery_approval";
/**
 * 呼び出し側の制作受付トランザクション内で配置と素材を固定する。
 * 運営の許諾は見ない（権利は顧客が納品版の承認時に一括で同意し、同意がなければ公開しない）。
 * ファイルと配置がある素材を使う。顧客が提出した画像は、受理済みで顧客が本番での利用を申告したものに限る。
 */
export async function captureDeliveryImageAssets(
  tx: DbOrTx,
  contractId: string,
  capturedAt: Date = new Date(),
): Promise<DeliveryImageAsset[]> {
  const [c] = await tx.select({ companyId: contracts.companyId }).from(contracts).where(eq(contracts.id, contractId));
  if (!c) throw new ImageAssetError("契約を確認できません");
  const assets = await tx
    .select()
    .from(imageAssets)
    .where(and(eq(imageAssets.companyId, c.companyId), ne(imageAssets.placement, "reference")))
    .orderBy(asc(imageAssets.id))
    .for("share");
  const submissions = assets.length
    ? await tx
        .select({
          assetId: imageSubmissions.assetId,
          status: imageSubmissions.status,
          requestedProduction: imageSubmissions.requestedProduction,
        })
        .from(imageSubmissions)
        .where(
          inArray(
            imageSubmissions.assetId,
            assets.map((a) => a.id),
          ),
        )
    : [];
  const result: DeliveryImageAsset[] = [];
  for (const a of assets) {
    if (a.placement === "reference") continue;
    const submission = submissions.find((s) => s.assetId === a.id);
    if (submission && (submission.status !== "accepted" || !submission.requestedProduction)) continue;
    const [f] = await tx
      .select({ sha256: imageAssetFiles.sha256 })
      .from(imageAssetFiles)
      .where(eq(imageAssetFiles.assetId, a.id));
    if (!f) continue;
    result.push({
      assetId: a.id,
      slot: a.placement,
      sha256: f.sha256,
      label: a.label,
      policy: {
        sourceType: a.sourceType,
        sourceUrl: a.sourceUrl,
        rightsStatus: "customer_claimed",
        allowedUses: ["production"],
        confirmedBy: CUSTOMER_CONSENT_CONFIRMER,
        confirmedAt: capturedAt.toISOString(),
        note: a.note,
      },
    });
  }
  return result;
}
export function parseDeliveryImageSnapshot(raw: unknown): DeliveryImageAsset[] | null {
  if (raw === null) return []; // 既存の制作回は素材なし。後から自動追加しない。
  if (!Array.isArray(raw) || raw.length > 2) return null;
  if (
    raw.some(
      (a) =>
        !a ||
        typeof a !== "object" ||
        !uuid.test(a.assetId ?? "") ||
        !/^([a-f0-9]{64})$/.test(a.sha256 ?? "") ||
        !["hero", "logo"].includes(a.slot) ||
        typeof a.label !== "string" ||
        !a.policy,
    )
  )
    return null;
  if (new Set(raw.map((a) => a.slot)).size !== raw.length || new Set(raw.map((a) => a.assetId)).size !== raw.length)
    return null;
  return raw;
}
/** 他社素材・消失した素材・変わったファイルでは制作や顧客共有を止める。運営の許諾状態は見ない。 */
export async function deliveryImageAssetsValid(db: DbOrTx, buildId: string | null, deliveryId: string, lock = false) {
  if (!buildId) return true;
  const [b] = await db
    .select({ snapshot: deliveryBuilds.imageAssetSnapshot, companyId: contracts.companyId })
    .from(deliveryBuilds)
    .innerJoin(deliveries, eq(deliveries.id, deliveryBuilds.deliveryId))
    .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
    .where(and(eq(deliveryBuilds.id, buildId), eq(deliveryBuilds.deliveryId, deliveryId)));
  if (!b) return false;
  const snapshot = parseDeliveryImageSnapshot(b.snapshot);
  if (!snapshot) return false;
  for (const s of [...snapshot].sort((a, b) => a.assetId.localeCompare(b.assetId))) {
    const query = db
      .select()
      .from(imageAssets)
      .where(and(eq(imageAssets.id, s.assetId), eq(imageAssets.companyId, b.companyId)));
    const [a] = await (lock ? query.for("share") : query);
    if (!a) return false;
    // 顧客が取り下げた提出画像は、素材の消失として扱う
    const [submission] = await db
      .select({ status: imageSubmissions.status })
      .from(imageSubmissions)
      .where(eq(imageSubmissions.assetId, a.id));
    if (submission?.status === "withdrawn") return false;
    const [f] = await db
      .select({ sha256: imageAssetFiles.sha256 })
      .from(imageAssetFiles)
      .where(eq(imageAssetFiles.assetId, a.id));
    if (f?.sha256 !== s.sha256) return false;
  }
  return true;
}
export async function deliveryVersionImagesValid(db: DbOrTx, versionId: string, lock = false) {
  const [v] = await db
    .select({ buildId: deliveryVersions.buildId, deliveryId: deliveryVersions.deliveryId })
    .from(deliveryVersions)
    .where(eq(deliveryVersions.id, versionId));
  return !!v && (await deliveryImageAssetsValid(db, v.buildId, v.deliveryId, lock));
}
/** ワーカー専用。固定した素材だけを取得し、実バイトのハッシュも検査する。 */
export async function loadDeliveryImageAssets(db: DbOrTx, buildId: string, deliveryId: string) {
  if (!(await deliveryImageAssetsValid(db, buildId, deliveryId)))
    throw new ImageAssetError(
      "制作に使う画像の素材またはファイルが変更・削除されています。素材を確認して再制作してください",
    );
  const [b] = await db
    .select({ snapshot: deliveryBuilds.imageAssetSnapshot })
    .from(deliveryBuilds)
    .where(eq(deliveryBuilds.id, buildId));
  const snapshot = parseDeliveryImageSnapshot(b!.snapshot)!;
  const result = [];
  for (const a of snapshot) {
    const [f] = await db.select().from(imageAssetFiles).where(eq(imageAssetFiles.assetId, a.assetId));
    if (!f) throw new ImageAssetError("制作素材が見つかりません");
    const bytes = Buffer.from(f.pngBase64, "base64");
    if (bytes.length !== f.byteSize || createHash("sha256").update(bytes).digest("hex") !== a.sha256)
      throw new ImageAssetError("制作素材の整合性を確認できません");
    result.push({ ...a, bytes });
  }
  return result;
}

/** Internal normalized image boundary shared by operator and customer uploads. */
export function validateNormalizedAssetImage({ png, width, height }: { png: Buffer; width: number; height: number }) {
  if (
    !Buffer.isBuffer(png) ||
    png.length < 24 ||
    png.length > 8 * 1024 * 1024 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    width < 1 ||
    height < 1 ||
    width > 2560 ||
    height > 2560 ||
    png.readUInt32BE(16) !== width ||
    png.readUInt32BE(20) !== height
  )
    throw new ImageAssetError("保存する画像の形式を確認できません");
}
