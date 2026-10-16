import { index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./common.ts";
import { companies } from "./companies.ts";
import { users } from "./users.ts";

export const contentEntries = pgTable(
  "content_entries",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    slug: text("slug").notNull(),
    currentRevision: integer("current_revision").notNull().default(1),
    publishedRevision: integer("published_revision"),
    publishedAt: ts("published_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [uniqueIndex("content_company_slug").on(t.companyId, t.slug), index("content_company").on(t.companyId)],
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
    category: text("category").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("content_entry_revision").on(t.entryId, t.revision)],
);
