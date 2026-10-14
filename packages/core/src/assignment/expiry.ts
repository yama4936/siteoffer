import { assignments, type DbOrTx } from "@siteoffer/db";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { snapshot } from "./shared.ts";

const EXPIRY_JOB: Actor = { kind: "system", job: "assignment-expiry" };

export interface ExpiryResult {
  /** 未着手のまま期限を過ぎて解除した担当 */
  released: string[];
  /** 活動済み（営業中・商談中・契約確認待ち）で期限を過ぎ、運営確認待ちにした担当 */
  escalated: string[];
}

/**
 * 期限切れの担当を処理する（12.2、AC-11）。ワーカーから定期的に呼ぶ。
 * - 確保のまま活動がない（未着手）→ 解除（released, unstarted_timeout）
 * - 活動済み（working・negotiating・contract_pending）→ 解除せず運営確認待ち（awaiting_ops）
 *   商談中を別ユーザーへ即座に渡さないため。営業中（working）の扱いは12.2で未決のため、安全側で運営確認待ちにしている。
 * 1件ずつ別トランザクションで処理し、状態が読み取り時から変わっていれば何もしない（二重実行に安全）。
 */
export async function releaseExpiredAssignments(db: DbOrTx, clock: Clock): Promise<ExpiryResult> {
  const now = clock.now();
  const candidates = await db
    .select()
    .from(assignments)
    .where(
      and(
        inArray(assignments.status, ["claimed", "working", "negotiating", "contract_pending"]),
        isNotNull(assignments.expiresAt),
        lte(assignments.expiresAt, now),
      ),
    );

  const result: ExpiryResult = { released: [], escalated: [] };
  for (const c of candidates) {
    await db.transaction(async (tx) => {
      const unstarted = c.status === "claimed" && c.lastActivityAt === null;
      const [updated] = await tx
        .update(assignments)
        .set(
          unstarted
            ? { status: "released", releasedAt: now, releaseReason: "unstarted_timeout" }
            : { status: "awaiting_ops" },
        )
        .where(and(eq(assignments.id, c.id), eq(assignments.status, c.status), lte(assignments.expiresAt, now)))
        .returning();
      if (!updated) return;
      await recordEvent(tx, clock, {
        actor: EXPIRY_JOB,
        action: unstarted ? "assignment.release_unstarted_timeout" : "assignment.escalate_overdue",
        targetType: "assignment",
        targetId: c.id,
        before: snapshot(c),
        after: snapshot(updated),
      });
      (unstarted ? result.released : result.escalated).push(c.id);
    });
  }
  return result;
}
