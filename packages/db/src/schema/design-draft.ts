import { integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, updatedAt } from "./common.ts";
import { companies } from "./companies.ts";
import { users } from "./users.ts";

/** Personal working copy, never an approved design. Null values retain the revision after consumption. */
export const designBriefDrafts = pgTable(
  "design_brief_drafts",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    context: text("context").notNull(),
    revision: integer("revision").notNull(),
    values: jsonb("values").$type<Record<string, string>>(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("design_draft_owner_context").on(t.userId, t.companyId, t.context)],
);
