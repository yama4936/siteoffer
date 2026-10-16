import { index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, ts, updatedAt } from "./common.ts";
import { companies } from "./companies.ts";
import { siteAudits } from "./site-audit.ts";

/** 診断から提案への引き継ぎ。業務更新と一括保存し、送信確認まで再送可能にする。 */
export const proposalHandoffs = pgTable(
  "proposal_handoffs",
  {
    sourceStepKey: text("source_step_key").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    auditId: uuid("audit_id")
      .notNull()
      .references(() => siteAudits.id),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: ts("lease_until"),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    sentAt: ts("sent_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("proposal_handoffs_pending").on(t.sentAt, t.nextAttemptAt, t.leaseUntil)],
);
