import { boolean, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, ts } from "./common.ts";
import { imageAssets } from "./image-assets.ts";
import { users } from "./users.ts";
export const imageSubmissions = pgTable(
  "image_submissions",
  {
    assetId: uuid("asset_id")
      .primaryKey()
      .references(() => imageAssets.id),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => users.id),
    status: text("status").$type<"pending" | "needs_changes" | "accepted" | "withdrawn">().notNull().default("pending"),
    revision: integer("revision").notNull().default(1),
    rightsBasis: text("rights_basis").$type<"own_work" | "licensed" | "permission">().notNull(),
    rightsNote: text("rights_note").notNull(),
    requestedDemo: boolean("requested_demo").notNull(),
    requestedProduction: boolean("requested_production").notNull(),
    reviewNote: text("review_note"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    submittedAt: createdAt(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    index("image_submissions_status").on(t.status, t.submittedAt),
    index("image_submissions_submitter").on(t.submittedBy),
  ],
);
export const imageSubmissionOperations = pgTable("image_submission_operations", {
  key: text("key").primaryKey(),
  payloadHash: text("payload_hash").notNull(),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => imageSubmissions.assetId),
  createdAt: createdAt(),
});
