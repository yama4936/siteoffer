import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id } from "./common.ts";
import { users } from "./users.ts";

/** 操作履歴（17章 AuditEvent）。サイト診断のsiteAuditsとは別物 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    actorId: uuid("actor_id").references(() => users.id),
    /** sales / ops / system / customer */
    actorKind: text("actor_kind").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_events_target").on(t.targetType, t.targetId),
    index("audit_events_publication_batch")
      .on(t.actorId, sql`(${t.after}->>'batchRequestId')`)
      .where(
        sql`${t.action}='publication_material.confirm' and ${t.targetType}='deployment' and ${t.after}->>'batchRequestId' is not null`,
      ),
  ],
);
