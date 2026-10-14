import { boolean, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { assignments } from "./assignment.ts";
import { createdAt, id, ts, updatedAt } from "./common.ts";
import { companies } from "./companies.ts";
import { users } from "./users.ts";

export const domainIntent = pgEnum("domain_intent", ["keep", "transfer_consult", "new", "undecided"]);
export const domainManager = pgEnum("domain_manager", ["company", "vendor", "unknown"]);
export const triState = pgEnum("tri_state", ["yes", "no", "unknown"]);

/**
 * ドメイン希望の聞き取り（13章）。
 * レジストラのパスワード・移管コード・鍵の欄は持たない。
 */
export const domainPreferences = pgTable("domain_preferences", {
  id: id(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  assignmentId: uuid("assignment_id").references(() => assignments.id),
  currentUrl: text("current_url"),
  currentDomain: text("current_domain"),
  intent: domainIntent("intent").notNull().default("undecided"),
  newDomainCandidates: text("new_domain_candidates").array().notNull().default([]),
  currentManager: domainManager("current_manager").notNull().default("unknown"),
  usesEmail: triState("uses_email").notNull().default("unknown"),
  customerWish: text("customer_wish"),
  needsOpsReview: boolean("needs_ops_review").notNull().default(true),
  confirmedAt: ts("confirmed_at"),
  recordedBy: uuid("recorded_by")
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
