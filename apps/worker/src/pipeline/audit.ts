import { runSiteAudit } from "@siteoffer/audit";
import { companies, websites } from "@siteoffer/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { closeStepAudits } from "../audit-cleanup.ts";
import { resumeSavedAudit } from "../audit-result.ts";
import { PermanentError, PreconditionError, type StepDefinition } from "../execute.ts";
import { dispatchProposalHandoffs, findProposalHandoff } from "../handoff.ts";
import { type AuditPayload, QUEUES, stepKeys } from "../queues.ts";
import { checkPublicHttpUrl } from "../url.ts";
import { moveCompanyStatus, PIPELINE_ACTOR, PROTECTED } from "./status.ts";

export type { AuditStepResult } from "../audit-result-types.ts";

import type { AuditStepResult } from "../audit-result-types.ts";

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
  async run(deps, payload, ctx) {
    const { db, clock } = deps;
    if (ctx.attempt > 1) await ctx.withOwnership((tx) => closeStepAudits(tx, clock, stepKeys.audit(payload)));
    const [company] = await db.select().from(companies).where(eq(companies.id, payload.companyId));
    if (!company) throw new PreconditionError(`企業がない：${payload.companyId}`);
    const base = { companyId: company.id, auditId: null, auditStatus: null, decision: null, proposalQueued: false };
    if (PROTECTED.includes(company.suppression)) return { ...base, skipped: `営業抑止（${company.suppression}）` };
    if (company.officialSiteStatus !== "confirmed") {
      return { ...base, skipped: `公式サイトが未確認（${company.officialSiteStatus}）` };
    }

    const key = stepKeys.audit(payload);
    const previous = await ctx.withOwnership((tx) => findProposalHandoff(tx, key));
    const dispatch = () =>
      dispatchProposalHandoffs(deps, key).catch(() => {
        deps.logger.warn("提案への引き継ぎは保存済みです。定期処理で再送します", { key });
      });
    if (previous) {
      await dispatch();
      return {
        ...base,
        skipped: null,
        auditId: previous.auditId,
        auditStatus: "evaluated",
        decision: "create",
        proposalQueued: true,
      };
    }

    const saved = await ctx.withOwnership((tx) => resumeSavedAudit(tx, clock, payload));
    if (saved) {
      if (saved.proposalQueued) await dispatch();
      return saved;
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

    const r = await runSiteAudit(db, clock, deps.audit, {
      websiteId: site.id,
      actor: PIPELINE_ACTOR,
      signal: ctx.signal,
      workerStep: { key, attempt: ctx.attempt },
      withOwnership: ctx.withOwnership,
    });
    await ctx.assertCurrent();
    if (!r.ok) throw new PermanentError(`${r.error}: ${r.message ?? ""}`);
    const out = r.value;
    if (out.status === "failed") throw new Error(`診断に失敗した：${out.failureReason ?? "理由不明"}`);

    const result = await ctx.withOwnership((tx) =>
      resumeSavedAudit(tx, clock, payload, { auditId: out.auditId, reused: false }),
    );
    if (!result)
      throw new PreconditionError(
        "診断中に公式サイトが変更されたため、結果の引き継ぎを止めました。対象を確認して再診断してください",
      );
    if (result.proposalQueued) await dispatch();
    return result;
  },
  async onGiveUp(deps, payload, reason) {
    await deps.db.transaction((tx) => closeStepAudits(tx, deps.clock, stepKeys.audit(payload)));
    // 引き継ぎ確定後の終了通知の失敗で、診断済みの企業を失敗へ戻さない。
    if (await findProposalHandoff(deps.db, stepKeys.audit(payload))) return;
    await moveCompanyStatus(deps.db, deps.clock, {
      companyId: payload.companyId,
      from: ["collected", "site_confirmed", "audited", "on_hold"],
      to: "failed",
      reason: `診断が止まった：${reason}`.slice(0, 500),
    });
  },
  summarize: (r) => r,
};
