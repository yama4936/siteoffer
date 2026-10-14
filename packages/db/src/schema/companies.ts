import { boolean, index, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./common.ts";

/** 公式サイトの確度（8.1） */
export const officialSiteStatus = pgEnum("official_site_status", [
  "confirmed",
  "candidate",
  "needs_review",
  "not_found",
]);

/** 企業共通の営業抑止。担当解除や再収集で消さない（12.3） */
export const salesSuppression = pgEnum("sales_suppression", [
  "none",
  "not_now",
  "do_not_contact",
  "excluded",
  "existing_customer",
]);

/** 提案の準備段階（18章「提案」）。担当・契約の状態とは混ぜない */
export const pipelineStatus = pgEnum("pipeline_status", [
  "collected",
  "site_confirmed",
  "audited",
  "generated",
  "in_review",
  "sellable",
  "on_hold",
  "failed",
]);

export const companies = pgTable(
  "companies",
  {
    id: id(),
    name: text("name").notNull(),
    corporateNumber: text("corporate_number").unique(),
    prefecture: text("prefecture"),
    city: text("city"),
    address: text("address"),
    addressSourceUrl: text("address_source_url"),
    industry: text("industry"),
    representativePhone: text("representative_phone"),
    officialSiteStatus: officialSiteStatus("official_site_status").notNull().default("not_found"),
    suppression: salesSuppression("suppression").notNull().default("none"),
    suppressionReason: text("suppression_reason"),
    suppressionUpdatedAt: ts("suppression_updated_at"),
    /** 「今は不要」の場合の、企業が示した再連絡の目安 */
    recontactAfter: ts("recontact_after"),
    pipelineStatus: pipelineStatus("pipeline_status").notNull().default("collected"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("companies_area").on(t.prefecture, t.city), index("companies_pipeline").on(t.pipelineStatus)],
);

export const websiteKind = pgEnum("website_kind", ["current", "proposal"]);

export const websites = pgTable(
  "websites",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    url: text("url").notNull(),
    /** 正規化URL。重複排除のキー（8.1） */
    normalizedUrl: text("normalized_url").notNull().unique(),
    domain: text("domain").notNull(),
    kind: websiteKind("kind").notNull().default("current"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("websites_company").on(t.companyId), index("websites_domain").on(t.domain)],
);
