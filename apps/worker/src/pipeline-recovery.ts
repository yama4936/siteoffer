import { createHash } from "node:crypto";
import { recordEvent } from "@siteoffer/core";
import { designVersions, proposals, proposalVersions } from "@siteoffer/db";
import { and, eq, sql } from "drizzle-orm";
import { closeStepAudits } from "./audit-cleanup.ts";
import { resumeSavedAudit } from "./audit-result.ts";
import type { WorkerDeps } from "./deps.ts";
import { findProposalHandoff } from "./handoff.ts";
import { readStepExecution, readStepState, STEP_ACTIONS, STEP_TARGET } from "./ledger.ts";
import { auditStep } from "./pipeline/audit.ts";
import { proposalStep } from "./pipeline/proposal.ts";
import { lockQueueClaim, parseQueueClaim } from "./queue-claim.ts";
import { auditPayloadSchema, proposalPayloadSchema, QUEUES } from "./queues.ts";

/** pg-bossが再試行を終えた後にも残る親台帳・業務状態を、同じトランザクションで閉じる。 */
export async function recoverPipelineSteps(deps: WorkerDeps) {
  if (deps.discoveryOnly) return [];
  const { db, clock } = deps;
  // queueClaimのある新形式だけを対象にする。稼働根拠がない旧形式を時刻だけで推測して閉じない。
  const candidates = await db.execute(sql`with latest as (
    select distinct on (target_id) target_id as key, "after" as detail, created_at
    from audit_events where target_type = 'worker_step' and action = 'worker.step_started'
      and "after"->>'queue' in (${QUEUES.audit}, ${QUEUES.proposal})
      and "after"->>'attempt' ~ '^[0-9]+$'
    order by target_id, ("after"->>'attempt')::integer desc
  ) select latest.key from latest left join pgboss.job j
    on j.id::text = latest.detail->'queueClaim'->>'id' and j.name = latest.detail->>'queue'
    where latest.detail->'queueClaim'->>'id' is not null
      and (j.id is null or j.state in ('failed', 'cancelled', 'completed'))
      and not exists (select 1 from audit_events e where e.target_type = 'worker_step'
        and e.target_id = latest.key and e.action in ('worker.step_failed', 'worker.step_succeeded')
        and e."after"->>'attempt' = latest.detail->>'attempt')
    order by latest.created_at limit 100`);
  const recovered: string[] = [];
  for (const candidate of (candidates as { rows: { key: string }[] }).rows) {
    const closed = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:step:${candidate.key}`}))`);
      const state = await readStepState(tx, candidate.key);
      if (!state.running) return false;
      const execution = await readStepExecution(tx, candidate.key, state.attempts);
      const claim = parseQueueClaim(execution.queueClaim);
      if (!claim || (execution.queue !== QUEUES.audit && execution.queue !== QUEUES.proposal)) return false;
      const job = await lockQueueClaim(tx, execution.queue, claim);
      if (job && !["failed", "cancelled", "completed"].includes(job.state)) return false;
      const reason =
        job?.state === "cancelled"
          ? "interrupted: 処理が取り消されたため停止しました"
          : "interrupted: 処理の接続が途切れ、自動再試行が終了しました。内容を確認して再実行してください";
      let alreadySaved = false;
      let restoredResult: Awaited<ReturnType<typeof resumeSavedAudit>> = null;
      if (execution.queue === QUEUES.audit) {
        const payload = auditPayloadSchema.safeParse(execution.payload);
        if (!payload.success || auditStep.key(payload.data) !== candidate.key) return false;
        alreadySaved = !!(await findProposalHandoff(tx, candidate.key));
        if (!alreadySaved) {
          restoredResult = await resumeSavedAudit(tx, clock, payload.data);
          alreadySaved = !!restoredResult;
        }
        if (alreadySaved) await closeStepAudits(tx, clock, candidate.key);
        else await auditStep.onGiveUp?.({ ...deps, db: tx }, payload.data, reason);
      } else {
        const payload = proposalPayloadSchema.safeParse(execution.payload);
        if (!payload.success || proposalStep.key(payload.data) !== candidate.key) return false;
        const [version] = await tx
          .select({ status: proposalVersions.status })
          .from(proposalVersions)
          .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
          .where(
            and(
              eq(proposals.companyId, payload.data.companyId),
              sql`${proposalVersions.content}->>'idempotencyKey' = ${candidate.key}`,
            ),
          );
        alreadySaved = !!version && ["in_review", "approved", "rejected"].includes(version.status);
        if (!alreadySaved && !payload.data.designVersionId) {
          const [design] = await tx
            .select({ id: designVersions.id })
            .from(designVersions)
            .where(
              and(
                eq(designVersions.companyId, payload.data.companyId),
                eq(designVersions.auditId, payload.data.auditId),
                eq(designVersions.requestKey, `initial:${createHash("sha256").update(candidate.key).digest("hex")}`),
              ),
            );
          alreadySaved = !!design;
        }
        if (!alreadySaved) await proposalStep.onGiveUp?.({ ...deps, db: tx }, payload.data, reason);
      }
      await recordEvent(tx, clock, {
        actor: { kind: "system", job: "pipeline-recovery" },
        action: alreadySaved ? STEP_ACTIONS.succeeded : STEP_ACTIONS.failed,
        targetType: STEP_TARGET,
        targetId: candidate.key,
        after: {
          queue: execution.queue,
          attempt: state.attempts,
          final: !alreadySaved,
          reason: alreadySaved
            ? (restoredResult?.skipped ?? "実行結果は保存済みのため、終了記録を回復しました")
            : reason,
          ...(restoredResult ? { summary: restoredResult } : {}),
          recovered: true,
        },
      });
      return true;
    });
    if (closed) recovered.push(candidate.key);
  }
  return recovered;
}
