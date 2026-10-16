import { sql } from "drizzle-orm";
import { boolean, index, integer, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./common.ts";
import { companies } from "./companies.ts";
import { users } from "./users.ts";

export const imageAssetSource = pgEnum("image_asset_source", [
  "original_site",
  "customer_upload",
  "generated",
  "operator_upload",
]);

export const imageAssetRightsStatus = pgEnum("image_asset_rights_status", [
  "unknown",
  "customer_claimed",
  "license_verified",
  "use_approved",
]);

export const imageAssetPlacement = pgEnum("image_asset_placement", ["reference", "hero", "logo"]);

/**
 * 企業ごとの画像素材台帳。ファイルは別テーブルに保存し、出所・権利確認・利用許可を管理する。
 * unknown の素材は評価参照だけに限り、営業デモ・本番利用のフラグを立てない。
 */
export const imageAssets = pgTable(
  "image_assets",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    label: text("label").notNull(),
    placement: imageAssetPlacement("placement").notNull().default("reference"),
    policyRevision: integer("policy_revision").notNull().default(0),
    sourceType: imageAssetSource("source_type").notNull(),
    sourceUrl: text("source_url"),
    rightsStatus: imageAssetRightsStatus("rights_status").notNull().default("unknown"),
    allowSalesDemo: boolean("allow_sales_demo").notNull().default(false),
    allowProduction: boolean("allow_production").notNull().default(false),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    confirmedAt: ts("confirmed_at"),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("image_assets_company").on(t.companyId),
    uniqueIndex("image_assets_placement").on(t.companyId, t.placement).where(sql`${t.placement} <> 'reference'`),
  ],
);

/** 確認対象を取り違えないよう一つの素材に一つのファイルを固定する。差し替えは新しい素材として登録する。 */
export const imageAssetFiles = pgTable("image_asset_files", {
  assetId: uuid("asset_id")
    .primaryKey()
    .references(() => imageAssets.id),
  pngBase64: text("png_base64").notNull(),
  sha256: text("sha256").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  byteSize: integer("byte_size").notNull(),
  uploadedBy: uuid("uploaded_by")
    .notNull()
    .references(() => users.id),
  uploadedAt: createdAt(),
});
