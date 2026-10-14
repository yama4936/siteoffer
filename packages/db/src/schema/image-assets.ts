import { boolean, index, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
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

/**
 * 企業ごとの画像素材台帳。ファイルのアップロード先ではなく、出所・権利確認・利用許可を管理する。
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
  (t) => [index("image_assets_company").on(t.companyId)],
);
