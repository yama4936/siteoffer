import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, ts, updatedAt } from "./common.ts";
import { companies, websites } from "./companies.ts";

/** 運営からの診断受付。受付時の対象を保持し、送信応答消失でも同じ依頼を再送する。 */
export const auditRequests = pgTable(
  "audit_requests",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    websiteId: uuid("website_id")
      .notNull()
      .references(() => websites.id),
    targetUrl: text("target_url").notNull(),
    status: text("status", { enum: ["queued", "processing", "completed", "failed", "blocked", "cancelled"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: ts("lease_until"),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    sentAt: ts("sent_at"),
    finishedAt: ts("finished_at"),
    message: text("message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("audit_requests_one_open_company").on(t.companyId).where(sql`${t.finishedAt} is null`),
    index("audit_requests_pending").on(t.finishedAt, t.nextAttemptAt, t.leaseUntil),
  ],
);
