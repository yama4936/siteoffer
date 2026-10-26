import { type Actor, type Clock, err, ok, recordEvent } from "@siteoffer/core";
import { auditEvents, auditRequests, companies, type DbOrTx, users } from "@siteoffer/db";
import { and, eq, sql } from "drizzle-orm";
import { auditRequestNeedsAttention } from "./audit-request-query.ts";
import { resumeSavedAudit } from "./audit-result.ts";
import { readStepExecution, readStepState } from "./ledger.ts";
import { PROTECTED } from "./pipeline/status.ts";
import { auditPayloadSchema, QUEUES, stepKeys } from "./queues.ts";

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const LIMIT = 20;
async function allowed(db: DbOrTx, actor: Actor | null) {
  if (actor?.kind !== "ops" || !UUID.test(actor.userId)) return false;
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  return !!user;
}
interface Candidate {
  auditId: string;
  companyId: string;
  companyName: string;
  status: "evaluated" | "unevaluable";
  decision: "create" | "hold" | "skip" | null;
  createdAt: Date;
  targetUrl: string;
  websiteId: string;
  siteId: string | null;
  siteUrl: string | null;
  officialStatus: string;
  suppression: (typeof companies.$inferSelect)["suppression"];
  sourceKey: string;
  requestPayload: unknown;
  queue: string;
}
export function auditRecoveryCandidatesQuery(companyId?: string, auditId?: string) {
  return sql`select a.id as "auditId", a.company_id as "companyId", c.name as "companyName", a.status, a.decision,
  a.created_at as "createdAt", a.target_url as "targetUrl", a.website_id as "websiteId", w.id as "siteId", w.url as "siteUrl",
  c.official_site_status as "officialStatus", c.suppression, source.detail->>'workerStepKey' as "sourceKey", started.detail->'payload' as "requestPayload", started.detail->>'queue' as queue
 from site_audits a join companies c on c.id=a.company_id
 join lateral (select e."after" as detail from audit_events e where e.target_type='site_audit' and e.target_id=a.id::text
   and e.action='site_audit.started' and e."after"->>'workerStepKey' is not null order by e.created_at desc limit 1) source on true
 join lateral (select e."after" as detail from audit_events e where e.target_type='worker_step'
   and e.target_id=source.detail->>'workerStepKey' and e.action='worker.step_started' and e."after"->>'attempt' ~ '^[0-9]+$'
   order by (e."after"->>'attempt')::numeric desc limit 1) started on true
 join lateral (select e.action,e."after" as detail from audit_events e where e.target_type='worker_step'
   and e.target_id=source.detail->>'workerStepKey' and e.action in ('worker.step_failed','worker.step_succeeded')
   and e."after"->>'attempt'=started.detail->>'attempt' order by e.created_at asc, e.action asc limit 1) ended on true
 left join lateral (select id,url from websites where company_id=c.id and kind='current' order by is_primary desc,created_at asc limit 1) w on true
 where a.status in ('evaluated','unevaluable') and ended.action='worker.step_failed' and ended.detail->>'final'='true'
   and a.id=(select newest.id from site_audits newest where newest.company_id=a.company_id order by newest.created_at desc,newest.id desc limit 1)
   and not exists(select 1 from audit_events applied where applied.target_type='worker_step' and applied.target_id=source.detail->>'workerStepKey'
      and applied.action='pipeline.audit_result_applied' and applied."after"->>'auditId'=a.id::text)
   and not exists(select 1 from proposal_handoffs h where h.source_step_key=source.detail->>'workerStepKey')
   ${companyId ? sql`and a.company_id=${companyId}::uuid` : sql``}
   ${auditId ? sql`and a.id=${auditId}::uuid` : sql``}`;
}
function blockedReason(c: Candidate) {
  const p = auditPayloadSchema.safeParse(c.requestPayload);
  if (
    c.queue !== QUEUES.audit ||
    !p.success ||
    p.data.companyId !== c.companyId ||
    stepKeys.audit(p.data) !== c.sourceKey
  )
    return "診断の依頼記録を照合できません。管理者に確認してください。";
  if (PROTECTED.includes(c.suppression)) return "営業抑止中です。企業情報で現在の対応方針を確認してください。";
  if (c.officialStatus !== "confirmed") return "公式サイトの確認が必要です。企業情報を確認してください。";
  let current: string | null = null;
  try {
    current = c.siteUrl ? new URL(c.siteUrl).href : null;
  } catch {}
  if (c.siteId !== c.websiteId || current !== c.targetUrl)
    return "診断後に公式サイトが変更されています。現在のサイトを確認してください。";
  return null;
}
export async function getAuditRecoveryCandidates(
  db: DbOrTx,
  actor: Actor | null,
  companyId?: string,
  requestedPage = 1,
) {
  if (!(await allowed(db, actor))) return err("forbidden");
  if (companyId && !UUID.test(companyId)) return err("invalid_input");
  const base = auditRecoveryCandidatesQuery(companyId);
  const count = await db.execute(sql`select count(*)::int as total from (${base}) candidate`);
  const total = (count as { rows: { total: number }[] }).rows[0]!.total;
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  const page = Math.min(pages, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const result = await db.execute(
    sql`${base} order by a.created_at asc,a.id asc limit ${LIMIT} offset ${(page - 1) * LIMIT}`,
  );
  const rows = (result as { rows: Candidate[] }).rows;
  return ok({
    total,
    pages,
    page,
    items: rows.map((c) => ({
      auditId: c.auditId,
      companyId: c.companyId,
      companyName: c.companyName,
      status: c.status,
      decision: c.decision,
      createdAt: new Date(c.createdAt).toISOString(),
      blockedReason: blockedReason(c),
    })),
  });
}
/** ホームでは同じ企業を重複して数えず、保存済み結果の再利用を先に案内する。 */
export async function getAuditAttentionWork(
  db: DbOrTx,
  actor: Actor | null,
  input: { query?: string; offset?: number; limit?: number } = {},
) {
  if (!(await allowed(db, actor))) return err("forbidden");
  if (
    (input.query?.length ?? 0) > 200 ||
    (input.offset !== undefined &&
      (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 2147483647))
  )
    return err("invalid_input");
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500))
    return err("invalid_input");
  const query = input.query?.trim() ?? "";
  const base = sql`with recovery as (${auditRecoveryCandidatesQuery()}), work as (
    select 'recovery' as kind, r."auditId" as id, r."companyId", r."companyName", r."createdAt", row_to_json(r) as detail
      from recovery r
    union all
    select 'request' as kind,r.id,r.company_id,c.name,r.created_at,
      json_build_object('status',r.status) as detail
      from audit_requests r join companies c on c.id=r.company_id
      where ${auditRequestNeedsAttention}
        and not exists(select 1 from recovery saved where saved."companyId"=r.company_id)
  ), filtered as(select * from work where ${query ? sql`position(lower(${query}) in lower("companyName")) > 0` : sql`true`})`;
  const count = await db.execute(sql`${base} select count(*)::int as total from filtered`);
  const result = await db.execute(
    sql`${base} select * from filtered order by date_trunc('milliseconds', "createdAt") asc,id asc limit ${input.limit ?? LIMIT} offset ${input.offset ?? 0}`,
  );
  const rows = (
    result as {
      rows: {
        kind: "recovery" | "request";
        id: string;
        companyId: string;
        companyName: string;
        createdAt: Date;
        detail: Candidate | { status: "failed" | "blocked" };
      }[];
    }
  ).rows;
  return ok({
    total: (count as { rows: { total: number }[] }).rows[0]!.total,
    items: rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      companyName: row.companyName,
      kind: row.kind,
      createdAt: new Date(row.createdAt).toISOString(),
      blockedReason: row.kind === "recovery" ? blockedReason(row.detail as Candidate) : null,
      reason:
        row.kind === "request"
          ? row.detail.status === "blocked"
            ? "診断対象の確認が必要です。企業情報と公式サイトを確認してください。"
            : "診断が停止しています。停止理由と対象サイトを確認し、必要なら再度依頼してください。"
          : null,
    })),
  });
}
/** 完了済みの採点を運営が後続処理へ反映する。AI生成やキュー送信は呼ばない。 */
export async function resumeAuditByOps(db: DbOrTx, clock: Clock, actor: Actor | null, auditId: string) {
  if (actor?.kind !== "ops" || !(await allowed(db, actor))) return err("forbidden", "運営だけが行える操作です");
  if (!UUID.test(auditId)) return err("invalid_input", "診断を確認してください");
  return db.transaction(async (tx) => {
    // 応答消失後の同じ操作を一度だけ確定する。利用停止と並行する操作も直列化する。
    const [user] = await tx
      .select({ status: users.status, role: users.role })
      .from(users)
      .where(eq(users.id, actor.userId))
      .for("update");
    if (user?.status !== "active" || user.role !== "ops") return err("forbidden", "操作権限を確認してください");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:audit-resume:${auditId}`}))`);
    const [receipt] = await tx
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "site_audit"),
          eq(auditEvents.targetId, auditId),
          eq(auditEvents.action, "audit.resumed_by_ops"),
        ),
      )
      .limit(1);
    if (receipt) {
      const r = receipt.after as { companyId: string; proposalQueued: boolean };
      return ok({ companyId: r.companyId, proposalQueued: r.proposalQueued, alreadyApplied: true });
    }
    const initial = await tx.execute(auditRecoveryCandidatesQuery(undefined, auditId));
    const candidate = (initial as { rows: Candidate[] }).rows[0];
    if (!candidate) return err("not_resumable", "状態が変わりました。最新の処理状況を確認してください");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:step:${candidate.sourceKey}`}))`);
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, candidate.companyId)).for("update");
    const state = await readStepState(tx, candidate.sourceKey);
    if (!state.gaveUp)
      return err("not_resumable", "自動処理が継続中、または完了済みです。最新の状態を確認してください");
    const execution = await readStepExecution(tx, candidate.sourceKey, state.attempts);
    const payload = auditPayloadSchema.safeParse(execution.payload);
    if (
      execution.queue !== QUEUES.audit ||
      !payload.success ||
      payload.data.companyId !== candidate.companyId ||
      stepKeys.audit(payload.data) !== candidate.sourceKey
    )
      return err("not_resumable", "診断の依頼記録を照合できません。管理者に確認してください");
    const refreshed = await tx.execute(auditRecoveryCandidatesQuery(undefined, auditId));
    const current = (refreshed as { rows: Candidate[] }).rows[0];
    if (!current) return err("not_resumable", "新しい診断や処理が見つかりました。最新の状態を確認してください");
    const blocked = blockedReason(current);
    if (blocked) return err("not_resumable", blocked);
    const applied = await resumeSavedAudit(tx, clock, payload.data, { auditId });
    if (!applied || applied.skipped)
      return err("not_resumable", "企業・公式サイトの状態が変わりました。最新の内容を確認してください");
    await recordEvent(tx, clock, {
      actor,
      action: "audit.resumed_by_ops",
      targetType: "site_audit",
      targetId: auditId,
      after: {
        companyId: applied.companyId,
        proposalQueued: applied.proposalQueued,
        sourceStepKey: candidate.sourceKey,
      },
    });
    const requestId = payload.data.requestKey.startsWith("ops:") ? payload.data.requestKey.slice(4) : null;
    if (requestId && UUID.test(requestId)) {
      await tx
        .update(auditRequests)
        .set({
          status: "completed",
          message: "保存済みの診断結果から再開し、判定を反映しました。",
          finishedAt: clock.now(),
          leaseToken: null,
          leaseUntil: null,
          updatedAt: clock.now(),
        })
        .where(and(eq(auditRequests.id, requestId), eq(auditRequests.companyId, applied.companyId)));
    }
    return ok({ companyId: applied.companyId, proposalQueued: applied.proposalQueued, alreadyApplied: false });
  });
}
