import { pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./common.ts";
import { companies } from "./companies.ts";
import { users } from "./users.ts";

export const shareLinkPurpose = pgEnum("share_link_purpose", ["proposal", "delivery"]);

/** 期限付き・取り消し可能な共有リンク（11章）。トークンはハッシュだけ保存する */
export const shareLinks = pgTable("share_links", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  purpose: shareLinkPurpose("purpose").notNull(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  /** proposal_versions.id または delivery_versions.id */
  targetId: uuid("target_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});
