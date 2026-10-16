import { index, integer, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id } from "./common.ts";
import { companies } from "./companies.ts";
import { productTerms } from "./product-terms.ts";
import { proposalVersions } from "./proposal.ts";
import { users } from "./users.ts";

/** 運営が営業へ引き継いだ版。再公開時は追加し、既存の担当・契約が参照する版を上書きしない。 */
export const salesOffers = pgTable(
  "sales_offers",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    version: integer("version").notNull(),
    productTermsId: uuid("product_terms_id")
      .notNull()
      .references(() => productTerms.id),
    proposalVersionId: uuid("proposal_version_id")
      .notNull()
      .references(() => proposalVersions.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sales_offers_company_version").on(t.companyId, t.version),
    index("sales_offers_terms").on(t.productTermsId),
  ],
);
