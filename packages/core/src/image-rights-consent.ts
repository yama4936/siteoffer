import { createHash } from "node:crypto";
import {
  approvals,
  auditEvents,
  contracts,
  type DbOrTx,
  deliveries,
  deliveryBuilds,
  deliveryVersions,
  imageAssetFiles,
  imageAssets,
} from "@siteoffer/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "./common/actor.ts";
import type { Clock } from "./common/clock.ts";
import { recordEvent } from "./common/events.ts";
import { type DeliveryImageAsset, deliveryImageAssetsValid, parseDeliveryImageSnapshot } from "./image-assets.ts";

/**
 * 画像の権利についての顧客の一括同意（2026-10-28 ユーザー決定）。
 * 運営が素材ごとに許諾を確認する代わりに、顧客が納品版を承認するときに1回だけ同意してもらい、
 * 公開・納品の条件にする。同意は監査記録（audit_events）に会社を対象として残す。
 * 同意した版の画像の組（素材・配置・ファイルハッシュ）が今の画像と一致しなければ、同意は無効。
 */
export const IMAGE_RIGHTS_CONSENT_ACTION = "image_rights.customer_consent";
export const IMAGE_RIGHTS_CONSENT_VERSION = "2026-10-28.v1";
export const IMAGE_RIGHTS_CONSENT_TEXT =
  "このサイトに提供・掲載する写真・ロゴ等について、当社が権利を保有している（または権利者から使用の許諾を得ている）ことを確認し、同意します。";
export const IMAGE_RIGHTS_CONSENT_TEXT_HASH = createHash("sha256").update(IMAGE_RIGHTS_CONSENT_TEXT).digest("hex");

export type ConsentImage = { assetId: string; slot: string; sha256: string };

/** 画像の組の指紋。並び順に依存しない。 */
export function imageSetFingerprint(images: readonly ConsentImage[]) {
  const rows = images
    .map((i) => [i.assetId.toLowerCase(), i.slot, i.sha256] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export interface ImageRightsConsentRecord {
  deliveryId: string;
  versionId: string;
  version: number;
  buildId: string | null;
  approvalId: string;
  shareLinkId: string;
  textVersion: string;
  textHash: string;
  consentedAt: string;
  images: ConsentImage[];
  imagesFingerprint: string;
}

/** 呼び出し側（顧客承認）のトランザクション内で、承認と同時に同意を記録する。 */
export async function recordCustomerImageRightsConsent(
  tx: DbOrTx,
  clock: Clock,
  input: {
    actor: Actor;
    companyId: string;
    deliveryId: string;
    versionId: string;
    version: number;
    buildId: string | null;
    approvalId: string;
    shareLinkId: string;
    images: readonly DeliveryImageAsset[];
  },
): Promise<ImageRightsConsentRecord> {
  const images = input.images.map((i) => ({ assetId: i.assetId, slot: i.slot, sha256: i.sha256 }));
  const after: ImageRightsConsentRecord = {
    deliveryId: input.deliveryId,
    versionId: input.versionId,
    version: input.version,
    buildId: input.buildId,
    approvalId: input.approvalId,
    shareLinkId: input.shareLinkId,
    textVersion: IMAGE_RIGHTS_CONSENT_VERSION,
    textHash: IMAGE_RIGHTS_CONSENT_TEXT_HASH,
    consentedAt: clock.now().toISOString(),
    images,
    imagesFingerprint: imageSetFingerprint(images),
  };
  await recordEvent(tx, clock, {
    actor: input.actor,
    action: IMAGE_RIGHTS_CONSENT_ACTION,
    targetType: "company",
    targetId: input.companyId,
    after,
  });
  return after;
}

const sha = /^[a-f0-9]{64}$/;
function parseConsentRecord(raw: unknown): ImageRightsConsentRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ImageRightsConsentRecord>;
  if (
    typeof r.versionId !== "string" ||
    typeof r.imagesFingerprint !== "string" ||
    typeof r.textVersion !== "string" ||
    !Array.isArray(r.images) ||
    r.images.some(
      (i) =>
        !i ||
        typeof i.assetId !== "string" ||
        typeof i.slot !== "string" ||
        typeof i.sha256 !== "string" ||
        !sha.test(i.sha256),
    ) ||
    imageSetFingerprint(r.images) !== r.imagesFingerprint
  )
    return null;
  return r as ImageRightsConsentRecord;
}

/** 旧来の運営の許諾（本番使用可）。顧客の同意記録がない承認済みの版でだけ参照する。 */
export function legacyProductionPermitted(
  a: Pick<typeof imageAssets.$inferSelect, "allowProduction" | "rightsStatus" | "confirmedBy" | "confirmedAt">,
) {
  return a.allowProduction && a.rightsStatus !== "unknown" && !!a.confirmedBy && !!a.confirmedAt;
}

export type ImageRightsConsentStatus =
  | { ok: true; basis: "customer_consent"; consentedAt: string | null }
  | { ok: true; basis: "legacy_ops_permission" }
  | { ok: false; reason: "no_consent" | "images_changed" };

/**
 * 版の画像の組に対して、顧客の同意（または旧データの扱い）が有効かを判定する（純粋関数）。
 * 素材の消失・ファイルハッシュの不一致は呼び出し側で別に検査する。
 * - 同意記録があれば、同意した画像の組と版の画像の組が一致する場合だけ有効。
 * - 同意記録がなく、承認済みの版で、使用画像のすべてに旧来の運営の許諾がある場合は同意と同等とみなす。
 */
export function evaluateImageRightsConsent(input: {
  images: readonly ConsentImage[];
  consent: unknown | null;
  approved: boolean;
  legacyPermitted: (assetId: string) => boolean;
}): ImageRightsConsentStatus {
  if (input.consent) {
    const record = parseConsentRecord(input.consent);
    if (!record || record.imagesFingerprint !== imageSetFingerprint(input.images))
      return { ok: false, reason: "images_changed" };
    return { ok: true, basis: "customer_consent", consentedAt: record.consentedAt ?? null };
  }
  if (input.approved && input.images.every((i) => input.legacyPermitted(i.assetId)))
    return { ok: true, basis: "legacy_ops_permission" };
  return { ok: false, reason: "no_consent" };
}

/** 版ごとの最新の同意記録（after）。 */
export async function latestImageRightsConsents(db: DbOrTx, versionIds: readonly string[]) {
  const result = new Map<string, unknown>();
  const ids = [...new Set(versionIds)];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const rows = await db
      .select({ versionId: sql<string>`${auditEvents.after}->>'versionId'`, after: auditEvents.after })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, IMAGE_RIGHTS_CONSENT_ACTION),
          eq(auditEvents.targetType, "company"),
          inArray(sql`${auditEvents.after}->>'versionId'`, ids.slice(offset, offset + 500)),
        ),
      )
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id));
    for (const row of rows) if (!result.has(row.versionId)) result.set(row.versionId, row.after);
  }
  return result;
}

/** 会社に顧客の画像の権利の同意記録があるか（記事の写真の掲載判定に使う）。 */
export async function companyHasImageRightsConsent(db: DbOrTx, companyId: string) {
  const [row] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "company"),
        eq(auditEvents.targetId, companyId),
        eq(auditEvents.action, IMAGE_RIGHTS_CONSENT_ACTION),
      ),
    )
    .limit(1);
  return !!row;
}

/** 版の画像（制作回に固定した素材）を読む。版・制作回・素材記録が読めなければ null。 */
export async function loadVersionImages(db: DbOrTx, versionId: string) {
  const [row] = await db
    .select({
      versionId: deliveryVersions.id,
      version: deliveryVersions.version,
      deliveryId: deliveryVersions.deliveryId,
      buildId: deliveryVersions.buildId,
      companyId: contracts.companyId,
    })
    .from(deliveryVersions)
    .innerJoin(deliveries, eq(deliveries.id, deliveryVersions.deliveryId))
    .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
    .where(eq(deliveryVersions.id, versionId));
  if (!row) return null;
  if (!row.buildId) return { ...row, images: [] as DeliveryImageAsset[] };
  const [build] = await db
    .select({ snapshot: deliveryBuilds.imageAssetSnapshot })
    .from(deliveryBuilds)
    .where(and(eq(deliveryBuilds.id, row.buildId), eq(deliveryBuilds.deliveryId, row.deliveryId)));
  if (!build) return null;
  const images = parseDeliveryImageSnapshot(build.snapshot);
  return images ? { ...row, images } : null;
}

export type DeliveryVersionConsentResult =
  | ImageRightsConsentStatus
  | { ok: false; reason: "version_not_found" | "images_invalid" };

/**
 * 公開・納品の条件：版の画像が存在し、ファイルが変わっておらず、顧客の同意（または旧データの扱い）があること。
 */
export async function deliveryVersionImageConsent(
  db: DbOrTx,
  versionId: string,
  lock = false,
): Promise<DeliveryVersionConsentResult> {
  const v = await loadVersionImages(db, versionId);
  if (!v) return { ok: false, reason: "version_not_found" };
  if (!(await deliveryImageAssetsValid(db, v.buildId, v.deliveryId, lock)))
    return { ok: false, reason: "images_invalid" };
  const [approval] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.deliveryVersionId, versionId), eq(approvals.decision, "approved")))
    .limit(1);
  const consent = (await latestImageRightsConsents(db, [versionId])).get(versionId) ?? null;
  const policies = new Map<string, boolean>();
  if (!consent && approval && v.images.length) {
    const rows = await db
      .select({
        id: imageAssets.id,
        allowProduction: imageAssets.allowProduction,
        rightsStatus: imageAssets.rightsStatus,
        confirmedBy: imageAssets.confirmedBy,
        confirmedAt: imageAssets.confirmedAt,
      })
      .from(imageAssets)
      .innerJoin(imageAssetFiles, eq(imageAssetFiles.assetId, imageAssets.id))
      .where(
        and(
          eq(imageAssets.companyId, v.companyId),
          inArray(
            imageAssets.id,
            v.images.map((i) => i.assetId),
          ),
        ),
      );
    for (const r of rows) policies.set(r.id, legacyProductionPermitted(r));
  }
  return evaluateImageRightsConsent({
    images: v.images,
    consent,
    approved: !!approval,
    legacyPermitted: (id) => policies.get(id) === true,
  });
}

export const IMAGE_RIGHTS_CONSENT_MESSAGES: Record<
  Exclude<DeliveryVersionConsentResult, { ok: true }>["reason"],
  string
> = {
  no_consent: "顧客の画像の権利への同意がありません。新しい版を作成し、顧客に再承認（同意）を依頼してください",
  images_changed:
    "顧客が同意した画像と、この版の画像が一致しません。新しい版を作成し、顧客に再承認（同意）を依頼してください",
  images_invalid: "使用画像の素材またはファイルが変更・削除されています。素材を確認して再制作してください",
  version_not_found: "公開対象の版を確認できません",
};
