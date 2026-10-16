import { index, integer, pgEnum, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { salesActivities } from "./assignment.ts";
import { createdAt, id, updatedAt } from "./common.ts";
import { users } from "./users.ts";

export const consultationStatus = pgEnum("consultation_status", ["open", "in_progress", "resolved"]);
/** 相談フラグのある活動が受付。まだ行がない場合は未対応・第0版とする（既存相談も対象）。 */
export const consultationCases = pgTable(
  "consultation_cases",
  {
    activityId: uuid("activity_id")
      .primaryKey()
      .references(() => salesActivities.id, { onDelete: "cascade" }),
    status: consultationStatus("status").notNull().default("open"),
    assignedTo: uuid("assigned_to").references(() => users.id),
    revision: integer("revision").notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [index("consultation_cases_status_assignee").on(t.status, t.assignedTo)],
);

/** 回答や追加相談は上書きせず、版ごとの履歴として保存する。 */
export const consultationEvents = pgTable(
  "consultation_events",
  {
    id: id(),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => salesActivities.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    operation: text("operation").notNull(),
    note: text("note").notNull().default(""),
    receiptKey: text("receipt_key").notNull().unique(),
    payloadHash: text("payload_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("consultation_events_activity_revision").on(t.activityId, t.revision)],
);

/** 個人ごとの確認位置。相手へ既読情報を公開せず、見た版までだけ記録する。 */
export const consultationReads = pgTable(
  "consultation_reads",
  {
    activityId: uuid("activity_id")
      .notNull()
      .references(() => salesActivities.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.activityId] })],
);
