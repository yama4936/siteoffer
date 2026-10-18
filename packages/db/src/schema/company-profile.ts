import { integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { ts } from "./common.ts";
import { companies } from "./companies.ts";
import { users } from "./users.ts";

/** Current, explicitly verified public company facts. Audit history is separate. */
export const companyProfiles = pgTable("company_profiles", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id),
  revision: integer("revision").notNull(),
  values: jsonb("values").notNull(),
  source: text("source").notNull(),
  confirmedBy: uuid("confirmed_by")
    .notNull()
    .references(() => users.id),
  confirmedAt: ts("confirmed_at").notNull(),
});
