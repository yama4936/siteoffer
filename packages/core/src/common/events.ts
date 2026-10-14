import { auditEvents, type DbOrTx } from "@siteoffer/db";
import { type Actor, actorUserId } from "./actor.ts";
import type { Clock } from "./clock.ts";

export interface RecordEventInput {
  actor: Actor;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
}

/** 操作履歴を残す。状態を変える処理は、同じトランザクションの中で必ず呼ぶ */
export async function recordEvent(db: DbOrTx, clock: Clock, input: RecordEventInput): Promise<void> {
  await db.insert(auditEvents).values({
    actorId: actorUserId(input.actor),
    actorKind: input.actor.kind,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    before: input.before ?? null,
    after: input.after ?? null,
    createdAt: clock.now(),
  });
}
