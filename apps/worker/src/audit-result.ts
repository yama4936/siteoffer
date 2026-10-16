import { type Clock, recordEvent } from "@siteoffer/core";
import { auditEvents, companies, type DbOrTx, siteAudits, websites } from "@siteoffer/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { AuditStepResult } from "./audit-result-types.ts";
import { recordProposalHandoff } from "./handoff-store.ts";
import { moveCompanyStatus, PIPELINE_ACTOR, PRE_REVIEW_STATUSES, PROTECTED } from "./pipeline/status.ts";
import { type AuditPayload, stepKeys } from "./queues.ts";

/** 呼び出し元が親ステップの所有権をロックしたトランザクションで使う。外部処理は行わない。 */
export async function resumeSavedAudit(
  db: DbOrTx,
  clock: Clock,
  payload: AuditPayload,
  options: { auditId?: string; reused?: boolean } = {},
): Promise<AuditStepResult | null> {
  const key = stepKeys.audit(payload);
  const [company] = await db.select().from(companies).where(eq(companies.id, payload.companyId)).for("update");
  if (!company) return null;
  const base: AuditStepResult = {
    companyId: company.id,
    skipped: null,
    auditId: null,
    auditStatus: null,
    decision: null,
    proposalQueued: false,
  };
  if (PROTECTED.includes(company.suppression)) return { ...base, skipped: `営業抑止（${company.suppression}）` };
  if (company.officialSiteStatus !== "confirmed")
    return { ...base, skipped: `公式サイトが未確認（${company.officialSiteStatus}）` };
  const [site] = await db
    .select()
    .from(websites)
    .where(and(eq(websites.companyId, company.id), eq(websites.kind, "current")))
    .orderBy(desc(websites.isPrimary), asc(websites.createdAt))
    .limit(1)
    .for("update");
  if (!site) return null;
  let targetUrl: string;
  try {
    targetUrl = new URL(site.url).href;
  } catch {
    return null;
  }
  const [audit] = await db
    .select()
    .from(siteAudits)
    .where(
      and(
        eq(siteAudits.companyId, company.id),
        eq(siteAudits.websiteId, site.id),
        eq(siteAudits.targetUrl, targetUrl),
        inArray(siteAudits.status, ["evaluated", "unevaluable"]),
        options.auditId ? eq(siteAudits.id, options.auditId) : undefined,
        sql`exists (select 1 from ${auditEvents} where ${auditEvents.targetType} = 'site_audit'
      and ${auditEvents.targetId} = ${siteAudits.id}::text and ${auditEvents.action} = 'site_audit.started'
      and ${auditEvents.after}->>'workerStepKey' = ${key})`,
      ),
    )
    .orderBy(desc(siteAudits.createdAt), desc(siteAudits.id))
    .limit(1)
    .for("update");
  if (!audit) return null;
  const result: AuditStepResult = {
    ...base,
    auditId: audit.id,
    auditStatus: audit.status as "evaluated" | "unevaluable",
    decision: audit.decision,
    proposalQueued: audit.status === "evaluated" && audit.decision === "create",
  };
  const [applied] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "worker_step"),
        eq(auditEvents.targetId, key),
        eq(auditEvents.action, "pipeline.audit_result_applied"),
        sql`${auditEvents.after}->>'auditId' = ${audit.id}`,
      ),
    )
    .limit(1);
  if (applied) return result;
  const hold = !result.proposalQueued && result.decision !== "skip";
  await moveCompanyStatus(db, clock, {
    companyId: company.id,
    from: [...PRE_REVIEW_STATUSES],
    to: hold ? "on_hold" : "audited",
    reason: result.proposalQueued
      ? "診断済み（判定：create）"
      : hold
        ? `判定保留（${audit.status === "unevaluable" ? "評価不能" : "閾値未設定・カバー率不足など"}）。生成しない`
        : "判定：skip（提案書を作らない）。生成しない",
    meta: { auditId: audit.id, decision: audit.decision },
  });
  if (result.proposalQueued)
    await recordProposalHandoff(db, clock, { sourceStepKey: key, companyId: company.id, auditId: audit.id });
  await recordEvent(db, clock, {
    actor: PIPELINE_ACTOR,
    action: "pipeline.audit_result_applied",
    targetType: "worker_step",
    targetId: key,
    after: { ...result, reused: options.reused ?? true },
  });
  return result;
}
