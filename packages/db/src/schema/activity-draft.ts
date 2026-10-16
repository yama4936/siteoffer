import { integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { assignments, salesActivities } from "./assignment.ts";
import { createdAt, id, updatedAt } from "./common.ts";
import { users } from "./users.ts";
export const activityDrafts = pgTable(
  "activity_drafts",
  {
    id: id(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    values: jsonb("values").$type<Record<string, string | boolean>>(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("activity_draft_owner_assignment").on(t.userId, t.assignmentId)],
);
/** Receipt only: no duplicate copies of activity notes. */
export const activitySubmissions = pgTable("activity_submissions", {
  requestKey: text("request_key").primaryKey(),
  activityId: uuid("activity_id")
    .notNull()
    .references(() => salesActivities.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});
