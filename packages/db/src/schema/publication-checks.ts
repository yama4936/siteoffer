import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, ts } from "./common.ts";
import { deployments } from "./delivery.ts";
import { users } from "./users.ts";
export const publicationMaterialChecks = pgTable("publication_material_checks", {
  deploymentId: uuid("deployment_id")
    .primaryKey()
    .references(() => deployments.id),
  revision: integer("revision").notNull(),
  fingerprint: text("fingerprint").notNull(),
  outcome: text("outcome").$type<"replaced" | "site_offline">().notNull(),
  replacementId: uuid("replacement_id").references(() => deployments.id),
  observedUrl: text("observed_url").notNull(),
  note: text("note").notNull(),
  checkedBy: uuid("checked_by")
    .notNull()
    .references(() => users.id),
  checkedAt: ts("checked_at").notNull(),
  revokedAt: ts("revoked_at"),
  revokedBy: uuid("revoked_by").references(() => users.id),
  revocationNote: text("revocation_note"),
});
export const publicationCheckOperations = pgTable("publication_check_operations", {
  key: text("key").primaryKey(),
  payloadHash: text("payload_hash").notNull(),
  deploymentId: uuid("deployment_id")
    .notNull()
    .references(() => deployments.id),
  createdAt: createdAt(),
});
