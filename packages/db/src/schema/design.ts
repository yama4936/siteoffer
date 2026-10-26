import { index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./common.ts";
import { companies } from "./companies.ts";
import { siteAudits } from "./site-audit.ts";
import { users } from "./users.ts";

export const designStatus = pgEnum("design_status", [
  "draft",
  "queued",
  "generating",
  "in_review",
  "approved",
  "rejected",
  "failed",
]);
/** Small, immutable raster artifacts live with their metadata so DB backups are complete. */
export const designVersions = pgTable(
  "design_versions",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    auditId: uuid("audit_id")
      .notNull()
      .references(() => siteAudits.id),
    version: integer("version").notNull(),
    requestKey: text("request_key").notNull().unique(),
    status: designStatus("status").notNull(),
    brief: jsonb("brief").notNull(),
    companySnapshot: jsonb("company_snapshot").notNull(),
    prompt: text("prompt").notNull(),
    source: text("source").notNull(),
    model: text("model"),
    requestId: text("request_id"),
    usage: jsonb("usage"),
    imageBase64: text("image_base64"),
    imageSha256: text("image_sha256"),
    width: integer("width"),
    height: integer("height"),
    error: text("error"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdBy: uuid("created_by").references(() => users.id),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    reviewNote: text("review_note"),
    buildRequestedAt: ts("build_requested_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("design_company_version").on(t.companyId, t.version), index("design_status_idx").on(t.status)],
);

export const proposalDocuments = pgTable("proposal_documents", {
  id: id(),
  documentKey: text("document_key").notNull().unique(),
  designVersionId: uuid("design_version_id")
    .notNull()
    .references(() => designVersions.id),
  /** Key contains the exact proposal UUID; snapshot is fixed on first successful export. */
  snapshot: jsonb("snapshot").notNull(),
  pdfBase64: text("pdf_base64").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: createdAt(),
});
