import { createHash } from "node:crypto";
import { type ArticleImage, type DbOrTx, imageAssetFiles, imageAssets, imageSubmissions } from "@siteoffer/db";
import { articleImagesSchema } from "@siteoffer/schemas";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor } from "./common/actor.ts";
import { authorizeContentEditor, ContentError } from "./content-auth.ts";
import { findSecretInFields } from "./domain-preference/secrets.ts";
import { companyHasImageRightsConsent, legacyProductionPermitted } from "./image-rights-consent.ts";

export type { ArticleImage } from "@siteoffer/db";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseArticleImages(raw: unknown): ArticleImage[] {
  const parsed = articleImagesSchema.safeParse(raw === undefined ? [] : raw);
  if (!parsed.success)
    throw new ContentError("写真は重複なしで8枚まで、代替テキストは200文字、説明は400文字以内で入力してください");
  if (parsed.data.some((i) => findSecretInFields({ alt: i.alt, caption: i.caption })))
    throw new ContentError("写真の説明に秘密情報らしき値があります。取り除いてください");
  return parsed.data;
}
const columns = {
  id: imageAssets.id,
  label: imageAssets.label,
  rightsStatus: imageAssets.rightsStatus,
  allowProduction: imageAssets.allowProduction,
  confirmedBy: imageAssets.confirmedBy,
  confirmedAt: imageAssets.confirmedAt,
  submittedBy: imageSubmissions.submittedBy,
  submissionStatus: imageSubmissions.status,
  width: imageAssetFiles.width,
  height: imageAssetFiles.height,
};
type ChoiceRow = {
  allowProduction: boolean;
  rightsStatus: "unknown" | "customer_claimed" | "license_verified" | "use_approved";
  confirmedBy: string | null;
  confirmedAt: Date | null;
  submissionStatus: string | null;
};
/**
 * 掲載できる写真（2026-10-28 ユーザー決定：運営の素材ごとの許諾確認をやめ、顧客の一括同意にした）。
 * - 顧客が提出した写真：提出時の同意で掲載できる（運営が受理済みであること）。
 * - 運営が登録した写真：その会社に顧客の画像の権利の同意記録があれば掲載できる。
 *   同意記録がない会社では、旧来の運営の許諾（本番使用可）がある写真だけを引き続き掲載する。
 */
function approved(r: ChoiceRow, consented: boolean) {
  if (r.submissionStatus !== null) return r.submissionStatus === "accepted";
  return consented || legacyProductionPermitted(r);
}
async function rows(db: DbOrTx, companyId: string, ids?: string[]) {
  if (ids && !ids.length) return [];
  return db
    .select(columns)
    .from(imageAssets)
    .innerJoin(imageAssetFiles, eq(imageAssetFiles.assetId, imageAssets.id))
    .leftJoin(imageSubmissions, eq(imageSubmissions.assetId, imageAssets.id))
    .where(and(eq(imageAssets.companyId, companyId), ids ? inArray(imageAssets.id, ids) : undefined))
    .orderBy(desc(imageAssets.createdAt), desc(imageAssets.id));
}
function visible(r: Awaited<ReturnType<typeof rows>>[number], actor: Actor, consented: boolean) {
  return (
    actor.kind === "ops" || approved(r, consented) || (actor.kind === "customer_user" && r.submittedBy === actor.userId)
  );
}
export async function listArticleImageChoices(db: DbOrTx, actor: Actor | null, companyId: string) {
  return db.transaction(async (tx) => {
    const who = await authorizeContentEditor(tx, actor, companyId);
    const consented = await companyHasImageRightsConsent(tx, companyId);
    return (await rows(tx, companyId))
      .filter((r) => visible(r, who, consented))
      .map((r) => ({
        id: r.id,
        label: r.label,
        width: r.width,
        height: r.height,
        approved: approved(r, consented),
        status: approved(r, consented)
          ? "掲載に利用できます"
          : r.submissionStatus === "withdrawn"
            ? "取り下げ済み"
            : r.submissionStatus !== null
              ? "運営の受付後に掲載できます"
              : "納品時の画像の権利の同意後に掲載できます",
      }));
  });
}
export type ArticleImageChoice = Awaited<ReturnType<typeof listArticleImageChoices>>[number];
/** Caller holds the company lock, also used by customer submissions and revocation. */
export async function validateArticleImageSelection(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  images: ArticleImage[],
  publishing = false,
) {
  images = parseArticleImages(images);
  const items = await rows(
    db,
    companyId,
    images.map((i) => i.assetId),
  );
  const consented = images.length ? await companyHasImageRightsConsent(db, companyId) : false;
  for (const image of images) {
    const item = items.find((r) => r.id === image.assetId);
    if (!item || !visible(item, actor, consented))
      throw new ContentError("記事の写真が見つかりません。会社と素材を確認してください");
    if (publishing && (!approved(item, consented) || !image.alt.trim()))
      throw new ContentError(
        "写真の掲載条件（受付済み・画像の権利の同意）と代替テキストを確認してから掲載してください",
      );
  }
}
export async function filterPublishedArticleImages(db: DbOrTx, companyId: string, images: ArticleImage[]) {
  const consented = images.length ? await companyHasImageRightsConsent(db, companyId) : false;
  const permitted = new Set(
    (
      await rows(
        db,
        companyId,
        images.map((i) => i.assetId),
      )
    )
      .filter((r) => approved(r, consented))
      .map((r) => r.id),
  );
  return images.filter((i) => permitted.has(i.assetId));
}
async function file(db: DbOrTx, assetId: string) {
  const [f] = await db.select().from(imageAssetFiles).where(eq(imageAssetFiles.assetId, assetId));
  if (!f) return null;
  const bytes = Buffer.from(f.pngBase64, "base64");
  if (bytes.length !== f.byteSize || createHash("sha256").update(bytes).digest("hex") !== f.sha256) return null;
  return { bytes, sha256: f.sha256 };
}
export async function getArticleEditorImage(db: DbOrTx, actor: Actor | null, companyId: string, assetId: string) {
  if (!uuid.test(assetId)) return null;
  return db.transaction(async (tx) => {
    const who = await authorizeContentEditor(tx, actor, companyId);
    const [r] = await rows(tx, companyId, [assetId]);
    return r && visible(r, who, await companyHasImageRightsConsent(tx, companyId)) ? file(tx, assetId) : null;
  });
}
/** Public callers must prove the article is currently published and references this asset. */
export async function getPublishedImageBytes(db: DbOrTx, companyId: string, assetId: string) {
  if (!uuid.test(assetId)) return null;
  const [r] = await rows(db, companyId, [assetId]);
  return r && approved(r, await companyHasImageRightsConsent(db, companyId)) ? file(db, assetId) : null;
}
