import { runSiteAudit } from "@siteoffer/audit";
import { companies, websites } from "@siteoffer/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { PermanentError, PreconditionError, type StepDefinition } from "../execute.ts";
import { type AuditPayload, type ProposalPayload, QUEUES, stepKeys } from "../queues.ts";
import { checkPublicHttpUrl } from "../url.ts";
import { moveCompanyStatus, PIPELINE_ACTOR, PRE_REVIEW_STATUSES, PROTECTED } from "./status.ts";

export interface AuditStepResult {
  companyId: string;
  /** 診断しなかった理由（営業抑止・公式サイト未確認） */
  skipped: string | null;
  auditId: string | null;
  auditStatus: "evaluated" | "unevaluable" | null;
  decision: "create" | "skip" | "hold" | null;
  /** 生成へ送った */
  proposalQueued: boolean;
}

/**
 * 企業の公式サイトを診断する（collect.py → 採点 → score.py → decide.py）。
 * - 判定が create（評価済み）なら audited に進め、生成へ送る。
 * - hold（閾値未設定・カバー率不足・評価不能）は on_hold、skip（改善の必要が小さい）は audited のまま止める。
 * - 診断の失敗（スクリプトの異常終了・採点の生成失敗）は再試行し、上限で企業を failed にする。
 */
export const auditStep: StepDefinition<AuditPayload, AuditStepResult> = {
  queue: QUEUES.audit,
  kind: "audit",
  key: stepKeys.audit,
  async run(deps, payload) {
    const { db, clock } = deps;
    const [company] = await db.select().from(companies).where(eq(companies.id, payload.companyId));
    if (!company) throw new PreconditionError(`企業がない：${payload.companyId}`);
    const base = { companyId: company.id, auditId: null, auditStatus: null, decision: null, proposalQueued: false };
    if (PROTECTED.includes(company.suppression)) return { ...base, skipped: `営業抑止（${company.suppression}）` };
    if (company.officialSiteStatus !== "confirmed") {
      return { ...base, skipped: `公式サイトが未確認（${company.officialSiteStatus}）` };
    }

    const [site] = await db
      .select()
      .from(websites)
      .where(and(eq(websites.companyId, company.id), eq(websites.kind, "current")))
      .orderBy(desc(websites.isPrimary), asc(websites.createdAt))
      .limit(1);
    if (!site) throw new PermanentError("診断する公式サイト（websites）がない");
    const urlCheck = checkPublicHttpUrl(site.url);
    if (!urlCheck.ok) throw new PermanentError(`診断できないURL：${urlCheck.reason}`);

    const r = await runSiteAudit(db, clock, deps.audit, { websiteId: site.id, actor: PIPELINE_ACTOR });
    if (!r.ok) throw new PermanentError(`${r.error}: ${r.message ?? ""}`);
    const out = r.value;
    if (out.status === "failed") throw new Error(`診断に失敗した：${out.failureReason ?? "理由不明"}`);

    const meta = { auditId: out.auditId, decision: out.decision };
    if (out.status === "evaluated" && out.decision === "create") {
      await moveCompanyStatus(db, clock, {
        companyId: company.id,
        from: [...PRE_REVIEW_STATUSES],
        to: "audited",
        reason: "診断済み（判定：create）",
        meta,
      });
      const next: ProposalPayload = { companyId: company.id, auditId: out.auditId, revision: "initial" };
      await deps.queue.send(QUEUES.proposal, next, { singletonKey: stepKeys.proposal(next) });
      return {
        ...base,
        skipped: null,
        auditId: out.auditId,
        auditStatus: out.status,
        decision: out.decision,
        proposalQueued: true,
      };
    }

    const hold = out.decision !== "skip";
    await moveCompanyStatus(db, clock, {
      companyId: company.id,
      from: [...PRE_REVIEW_STATUSES],
      to: hold ? "on_hold" : "audited",
      reason: hold
        ? `判定保留（${out.status === "unevaluable" ? "評価不能" : "閾値未設定・カバー率不足など"}）。生成しない`
        : "判定：skip（提案書を作らない）。生成しない",
      meta,
    });
    return {
      ...base,
      skipped: null,
      auditId: out.auditId,
      auditStatus: out.status,
      decision: out.decision,
      proposalQueued: false,
    };
  },
  async onGiveUp(deps, payload, reason) {
    await moveCompanyStatus(deps.db, deps.clock, {
      companyId: payload.companyId,
      from: ["collected", "site_confirmed", "audited", "on_hold"],
      to: "failed",
      reason: `診断が止まった：${reason}`.slice(0, 500),
    });
  },
  summarize: (r) => r,
};
