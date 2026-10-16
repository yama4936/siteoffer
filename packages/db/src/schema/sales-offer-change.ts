import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { assignments } from "./assignment.ts";
import { createdAt, id, ts } from "./common.ts";
import { salesOffers } from "./sales-offer.ts";
import { users } from "./users.ts";

export const salesOfferChangeStatus = pgEnum("sales_offer_change_status", [
  "pending",
  "accepted",
  "declined",
  "cancelled",
]);
export const salesOfferChanges = pgTable(
  "sales_offer_changes",
  {
    id: id(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id),
    salesUserId: uuid("sales_user_id")
      .notNull()
      .references(() => users.id),
    fromOfferId: uuid("from_offer_id")
      .notNull()
      .references(() => salesOffers.id),
    toOfferId: uuid("to_offer_id")
      .notNull()
      .references(() => salesOffers.id),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    status: salesOfferChangeStatus("status").notNull().default("pending"),
    responseNote: text("response_note"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sales_offer_changes_pending_assignment").on(t.assignmentId).where(sql`${t.status}='pending'`),
    index("sales_offer_changes_history").on(t.assignmentId, t.createdAt),
  ],
);
