import { type DbOrTx, salesOfferChanges } from "@siteoffer/db";
import { and, eq } from "drizzle-orm";
import { type Actor, actorUserId } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
/** Caller holds the assignment row lock and ends the assignment in this transaction. */
export async function cancelOfferChangesOnAssignmentEnd(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  assignmentId: string,
  reason: string,
) {
  const rows = await db
    .update(salesOfferChanges)
    .set({ status: "cancelled", responseNote: reason, decidedBy: actorUserId(actor), decidedAt: clock.now() })
    .where(and(eq(salesOfferChanges.assignmentId, assignmentId), eq(salesOfferChanges.status, "pending")))
    .returning();
  for (const row of rows)
    await recordEvent(db, clock, {
      actor,
      action: "sales_offer.change_cancelled",
      targetType: "assignment",
      targetId: assignmentId,
      after: row,
    });
}
