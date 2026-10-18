import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./common.ts";
import { companies } from "./companies.ts";
import { users } from "./users.ts";

export type ArticleImage = { assetId: string; alt: string; caption: string };

export const contentImports = pgTable(
  "content_imports",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    requestId: uuid("request_id").notNull().unique(),
    payloadHash: text("payload_hash").notNull(),
    fileName: text("file_name").notNull(),
    fileSha256: text("file_sha256").notNull(),
    format: text("format").notNull(),
    importedCount: integer("imported_count").notNull(),
    skippedCount: integer("skipped_count").notNull(),
    entryIds: jsonb("entry_ids").$type<string[]>().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("content_imports_company").on(t.companyId, t.createdAt)],
);

export const contentEntries = pgTable(
  "content_entries",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    slug: text("slug").notNull(),
    sourceUrl: text("source_url"),
    /** Explicit ops opt-in. Null keeps imported source metadata private and inactive. */
    legacyPath: text("legacy_path"),
    legacyRevision: integer("legacy_revision").notNull().default(0),
    originalPublishedAt: ts("original_published_at"),
    importId: uuid("import_id").references(() => contentImports.id),
    currentRevision: integer("current_revision").notNull().default(1),
    publishedRevision: integer("published_revision"),
    publicationRevision: integer("publication_revision").notNull().default(0),
    publishedAt: ts("published_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("content_company_slug").on(t.companyId, t.slug),
    uniqueIndex("content_company_legacy_path").on(t.companyId, t.legacyPath),
    index("content_company").on(t.companyId),
    index("content_company_updated").on(t.companyId, t.updatedAt, t.id),
  ],
);
export const contentRevisions = pgTable(
  "content_revisions",
  {
    id: id(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => contentEntries.id),
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    images: jsonb("images").$type<ArticleImage[]>().notNull().default([]),
    category: text("category").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("content_entry_revision").on(t.entryId, t.revision)],
);

/** Private working copies are isolated by operator, company and article (or the new-article slot). */
export const contentWorkingCopies = pgTable(
  "content_working_copies",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    revision: integer("revision").notNull(),
    values: jsonb("values").$type<{
      slug: string;
      title: string;
      body: string;
      category: string;
      baseRevision: string;
      images?: ArticleImage[];
    }>(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [uniqueIndex("content_working_copy_owner_scope").on(t.userId, t.companyId, t.scope)],
);

export const contentOperations = pgTable("content_operations", {
  key: text("key").primaryKey(),
  payloadHash: text("payload_hash").notNull(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  entryId: uuid("entry_id")
    .notNull()
    .references(() => contentEntries.id),
  revision: integer("revision").notNull(),
  createdAt: createdAt(),
});
