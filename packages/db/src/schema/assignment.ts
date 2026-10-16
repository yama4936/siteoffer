import { sql } from "drizzle-orm";
import { boolean, index, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./common.ts";
import { companies } from "./companies.ts";
import { users } from "./users.ts";

/** 担当の状態（18章「担当」）。released・lost・completed 以外が「有効な担当」 */
export const assignmentStatus = pgEnum("assignment_status", [
  "claimed",
  "working",
  "negotiating",
  "awaiting_ops",
  "contract_pending",
  "completed",
  "released",
  "lost",
]);

export const ACTIVE_ASSIGNMENT_STATUSES = [
  "claimed",
  "working",
  "negotiating",
  "awaiting_ops",
  "contract_pending",
] as const;

export const assignments = pgTable(
  "assignments",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    status: assignmentStatus("status").notNull().default("claimed"),
    claimedAt: ts("claimed_at").notNull(),
    expiresAt: ts("expires_at"),
    lastActivityAt: ts("last_activity_at"),
    nextActionAt: ts("next_action_at"),
    releasedAt: ts("released_at"),
    releaseReason: text("release_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    // 同一企業の有効な担当は同時に1人（12.1、AC-10）
    uniqueIndex("assignments_one_active_per_company")
      .on(t.companyId)
      .where(sql`${t.status} in ('claimed', 'working', 'negotiating', 'awaiting_ops', 'contract_pending')`),
    index("assignments_user").on(t.userId, t.status),
  ],
);

/** 活動の種類（12.3） */
export const salesActivityKind = pgEnum("sales_activity_kind", [
  "not_started",
  "no_answer",
  "callback_scheduled",
  "proposal_sent",
  "negotiating",
  "contract_review",
  "contract_completed",
  "lost",
  "declined",
]);

export const salesActivities = pgTable(
  "sales_activities",
  {
    id: id(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: salesActivityKind("kind").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    note: text("note"),
    nextActionAt: ts("next_action_at"),
    consultOps: boolean("consult_ops").notNull().default(false),
    nextActionMode: text("next_action_mode").notNull().default("keep"),
    createdAt: createdAt(),
  },
  (t) => [index("sales_activities_assignment").on(t.assignmentId)],
);
