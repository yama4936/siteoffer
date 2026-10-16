import { type Actor, type Clock, err, ok, recordEvent } from "@siteoffer/core";
import {
  auditEvents,
  auditRequests,
  companies,
  type DbOrTx,
  designVersions,
  proposalHandoffs,
  siteAudits,
  users,
  websites,
} from "@siteoffer/db";
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { getAuditRecoveryCandidates } from "./audit-recovery.ts";
import { PROTECTED } from "./pipeline/status.ts";
import { stepKeys } from "./queues.ts";
import { checkPublicHttpUrl } from "./url.ts";

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** 旧データの進行状態が未更新でも、営業へ進んだ企業を初回診断へ戻さない。 */
export function salesHistoryExists(companyId: SQL) {
  return sql`(exists(select 1 from assignments where company_id=${companyId})
    or exists(select 1 from contracts where company_id=${companyId})
    or exists(select 1 from proposals where company_id=${companyId}))`;
}
export function auditRequestPayload(r: { id: string; companyId: string }) {
  return { companyId: r.companyId, requestKey: `ops:${r.id}` };
}
export function auditRequestKey(r: { id: string; companyId: string }) {
  return stepKeys.audit(auditRequestPayload(r));
}
export async function isAuditOperator(db: DbOrTx, actor: Actor | null) {
  if (actor?.kind !== "ops" || !UUID.test(actor.userId)) return false;
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  return !!u;
}
export async function currentAuditSite(db: DbOrTx, companyId: string) {
  const [site] = await db
    .select()
    .from(websites)
    .where(and(eq(websites.companyId, companyId), eq(websites.kind, "current")))
    .orderBy(desc(websites.isPrimary), asc(websites.createdAt))
    .limit(1);
  return site;
}
/** DBの会社行をロックしてから使う。採点済みの回復を優先し、制作と競合する新規依頼を避ける。 */
async function requestIssue(db: DbOrTx, actor: Actor, company: typeof companies.$inferSelect) {
  if (PROTECTED.includes(company.suppression)) return "営業抑止中です。企業情報で現在の対応方針を確認してください。";
  if (company.officialSiteStatus !== "confirmed") return "先に公式サイトを確認済みにしてください。";
  if (!["collected", "site_confirmed", "audited", "on_hold", "failed"].includes(company.pipelineStatus))
    return "制作・営業が進行しています。現在の提案と対応状況を先に確認してください。";
  const site = await currentAuditSite(db, company.id);
  if (!site || !checkPublicHttpUrl(site.url).ok) return "診断できる公開HTTP/HTTPSの公式サイトを確認してください。";
  const [active] = await db
    .select({ id: siteAudits.id })
    .from(siteAudits)
    .where(and(eq(siteAudits.companyId, company.id), inArray(siteAudits.status, ["queued", "collecting", "scoring"])))
    .limit(1);
  if (active) return "診断が進行中です。処理状況で進捗を確認してください。";
  const [design] = await db
    .select({ id: designVersions.id })
    .from(designVersions)
    .where(eq(designVersions.companyId, company.id))
    .limit(1);
  const [handoff] = await db
    .select({ id: proposalHandoffs.auditId })
    .from(proposalHandoffs)
    .where(and(eq(proposalHandoffs.companyId, company.id), isNull(proposalHandoffs.sentAt)))
    .limit(1);
  if (design || handoff)
    return "制作の受付またはデザインが存在します。デザイン・提案書で現在の内容を確認してください。";
  const recovery = await getAuditRecoveryCandidates(db, actor, company.id);
  if (recovery.ok && recovery.value.items.some((r) => !r.blockedReason))
    return "保存済みの診断を再利用できます。「処理状況・再開を確認」から再開してください。";
  // 別経路で送信済みの診断も二重受付しない。pg-boss未起動のテスト・初期DBでは表がまだない。
  const exists = await db.execute(sql`select to_regclass('pgboss.job') is not null as present`);
  if ((exists as { rows: { present: boolean }[] }).rows[0]?.present) {
    const jobs = await db.execute(
      sql`select 1 from pgboss.job where name in ('pipeline.audit','pipeline.proposal') and data->>'companyId'=${company.id} and state in ('created','retry','active') limit 1`,
    );
    if ((jobs as { rows: unknown[] }).rows.length)
      return "診断の依頼が待機中または実行中です。処理状況で進捗を確認してください。";
  }
  return null;
}
export async function getCompanyAuditRequest(db: DbOrTx, actor: Actor | null, companyId: string) {
  if (!(await isAuditOperator(db, actor))) return err("forbidden");
  if (!UUID.test(companyId)) return err("invalid_input");
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) return err("not_found");
  const [request] = await db
    .select()
    .from(auditRequests)
    .where(eq(auditRequests.companyId, companyId))
    .orderBy(desc(auditRequests.createdAt), desc(auditRequests.id))
    .limit(1);
  const site = await currentAuditSite(db, companyId);
  const issue =
    request && !request.finishedAt
      ? "診断依頼は受付済みです。自動で処理されます。"
      : await requestIssue(db, actor!, company);
  return ok({
    targetUrl: site && checkPublicHttpUrl(site.url).ok ? new URL(site.url).href : null,
    blockedReason: issue,
    request: request
      ? {
          id: request.id,
          status: request.status,
          targetUrl: request.targetUrl,
          message: request.message,
          createdAt: request.createdAt.toISOString(),
          finishedAt: request.finishedAt?.toISOString() ?? null,
        }
      : null,
  });
}
/** 受付は外部APIを呼ばず、対象と操作記録を一括保存する。同一操作・同一企業の連打を一件へ集約する。 */
export async function requestAuditByOps(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: {
    companyId: string;
    requestId: string;
    initialOnly?: boolean;
    expectedTarget?: { websiteId: string; url: string };
  },
) {
  if (actor?.kind !== "ops" || !(await isAuditOperator(db, actor))) return err("forbidden", "運営だけが行える操作です");
  if (!UUID.test(input.companyId) || !UUID.test(input.requestId))
    return err("invalid_input", "企業と依頼を確認してください");
  return db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, actor.userId)).for("update");
    if (u?.role !== "ops" || u.status !== "active") return err("forbidden", "操作権限を確認してください");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:audit-operation:${input.requestId}`}))`);
    const [receipt] = await tx
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "audit_request_operation"),
          eq(auditEvents.targetId, input.requestId),
          eq(auditEvents.action, "audit.request_received"),
        ),
      )
      .limit(1);
    if (receipt) {
      const r = receipt.after as { companyId: string; requestId: string };
      return r.companyId === input.companyId
        ? ok({ requestId: r.requestId, alreadyAccepted: true })
        : err("invalid_input", "この操作は別の企業で使用済みです");
    }
    const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).for("update");
    if (!company) return err("not_found", "企業が見つかりません");
    const [same] = await tx.select().from(auditRequests).where(eq(auditRequests.id, input.requestId));
    if (same)
      return same.companyId === company.id
        ? ok({ requestId: same.id, alreadyAccepted: true })
        : err("invalid_input", "この依頼は別の企業で使用済みです");
    if (input.expectedTarget) {
      const target = await currentAuditSite(tx, company.id);
      const checked = target ? checkPublicHttpUrl(target.url) : null;
      if (
        target?.id !== input.expectedTarget.websiteId ||
        !checked?.ok ||
        checked.url.href !== input.expectedTarget.url
      )
        return err("target_changed", "診断対象が変更されました。現在の公式サイトを確認して選び直してください。");
    }
    const [pending] = await tx
      .select()
      .from(auditRequests)
      .where(and(eq(auditRequests.companyId, company.id), isNull(auditRequests.finishedAt)));
    if (pending) {
      await recordEvent(tx, clock, {
        actor,
        action: "audit.request_received",
        targetType: "audit_request_operation",
        targetId: input.requestId,
        after: { companyId: company.id, requestId: pending.id },
      });
      return ok({ requestId: pending.id, alreadyAccepted: true });
    }
    if (input.initialOnly) {
      const prior = await tx.execute(sql`select 1 from audit_requests where company_id=${company.id}::uuid
        union all select 1 from site_audits where company_id=${company.id}::uuid
        union all select 1 where ${salesHistoryExists(sql`${company.id}::uuid`)} limit 1`);
      if (
        !["collected", "site_confirmed"].includes(company.pipelineStatus) ||
        (prior as { rows: unknown[] }).rows.length
      )
        return err("not_ready", "すでに診断の受付・結果、または進行中の作業があります。企業画面で確認してください。");
    }
    const issue = await requestIssue(tx, actor, company);
    if (issue) return err("not_ready", issue);
    const site = (await currentAuditSite(tx, company.id))!;
    await tx.insert(auditRequests).values({
      id: input.requestId,
      companyId: company.id,
      websiteId: site.id,
      targetUrl: new URL(site.url).href,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      nextAttemptAt: clock.now(),
    });
    await recordEvent(tx, clock, {
      actor,
      action: "audit.requested",
      targetType: "company",
      targetId: company.id,
      after: {
        requestId: input.requestId,
        websiteId: site.id,
        targetUrl: new URL(site.url).href,
        initialOnly: input.initialOnly === true,
      },
    });
    await recordEvent(tx, clock, {
      actor,
      action: "audit.request_received",
      targetType: "audit_request_operation",
      targetId: input.requestId,
      after: { companyId: company.id, requestId: input.requestId },
    });
    return ok({ requestId: input.requestId, alreadyAccepted: false });
  });
}
/** ワーカーが対象を再照合する。依頼後のサイト差し替えを別サイトへの診断と取り違えない。 */
export async function validateAuditRequest(db: DbOrTx, payload: { companyId: string; requestKey: string }) {
  if (!payload.requestKey.startsWith("ops:")) return null;
  const id = payload.requestKey.slice(4);
  if (!UUID.test(id)) return "診断の依頼番号が不正です";
  const [r] = await db
    .select()
    .from(auditRequests)
    .where(and(eq(auditRequests.id, id), eq(auditRequests.companyId, payload.companyId)));
  if (!r) return "診断の受付が見つかりません";
  if (r.finishedAt) return "この診断依頼は終了済みです。現在の診断結果を確認してください。";
  // 初回診断のまとめ受付は、待機中に別経路で診断済みになった企業を再採点しない。
  // 同じ依頼が作った診断は除外し、ワーカー自身の正当な再試行は継続できる。
  const firstOnly = await db.execute(sql`select 1 from audit_events e where e.action='audit.requested'
    and e.target_type='company' and e.target_id=${r.companyId} and e."after"->>'requestId'=${r.id}
    and e."after"->>'initialOnly'='true' limit 1`);
  if ((firstOnly as { rows: unknown[] }).rows.length) {
    const sales = await db.execute(sql`select 1 where ${salesHistoryExists(sql`${r.companyId}::uuid`)}`);
    if ((sales as { rows: unknown[] }).rows.length)
      return "受付後に営業・提案の履歴が見つかりました。現在の案件と契約を確認してください。";
    const other = await db.execute(sql`select 1 from site_audits a where a.company_id=${r.companyId}::uuid
      and not exists(select 1 from audit_events e where e.target_type='site_audit' and e.target_id=a.id::text
        and e.action='site_audit.started' and e."after"->>'workerStepKey'=${auditRequestKey(r)}) limit 1`);
    if ((other as { rows: unknown[] }).rows.length)
      return "受付後に別の診断が見つかりました。既存の結果と処理状況を確認してください。";
  }

  const [company] = await db.select().from(companies).where(eq(companies.id, payload.companyId));
  const site = await currentAuditSite(db, payload.companyId);
  if (company && !["collected", "site_confirmed", "audited", "on_hold", "failed"].includes(company.pipelineStatus))
    return "受付後に制作・営業が進行しました。現在の提案と対応状況を確認してください。";
  if (!company || PROTECTED.includes(company.suppression) || company.officialSiteStatus !== "confirmed")
    return "企業または公式サイトの状態が変わりました。企業情報を確認してください。";
  if (!site || site.id !== r.websiteId || !checkPublicHttpUrl(site.url).ok || new URL(site.url).href !== r.targetUrl)
    return "受付後に公式サイトが変更されました。対象を確認して新しく診断を依頼してください。";
  return null;
}
