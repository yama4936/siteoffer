import { type Clock, recordEvent } from "@siteoffer/core";
import { auditEvents, type DbOrTx, siteAudits } from "@siteoffer/db";
import { and, inArray, sql } from "drizzle-orm";

/** 同じ親ステップの未完了診断だけを閉じる。他の依頼・完了済み結果には触れない。 */
export async function closeStepAudits(db: DbOrTx, clock: Clock, key: string) {
  const rows = await db
    .update(siteAudits)
    .set({
      status: "failed",
      failureReason: "診断処理が中断されました。元の依頼の再試行・停止状況を確認してください。",
      updatedAt: clock.now(),
    })
    .where(
      and(
        inArray(siteAudits.status, ["collecting", "scoring"]),
        sql`exists (
    select 1 from ${auditEvents} where ${auditEvents.targetType} = 'site_audit'
    and ${auditEvents.targetId} = ${siteAudits.id}::text and ${auditEvents.action} = 'site_audit.started'
    and ${auditEvents.after}->>'workerStepKey' = ${key})`,
      ),
    )
    .returning({ id: siteAudits.id });
  for (const row of rows)
    await recordEvent(db, clock, {
      actor: { kind: "system", job: "pipeline-recovery" },
      action: "site_audit.failed",
      targetType: "site_audit",
      targetId: row.id,
      after: { status: "failed", reason: "interrupted", workerStepKey: key },
    });
  return rows.length;
}
