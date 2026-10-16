import { type Actor, type Clock, err, ok, recordEvent } from "@siteoffer/core";
import { auditRequests, type DbOrTx, users } from "@siteoffer/db";
import { eq, sql } from "drizzle-orm";
import { auditRequestKey, isAuditOperator } from "./audit-request.ts";
import { readStepState } from "./ledger.ts";

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const AUDIT_REQUEST_VIEWS = {
  open: "対応中・要確認",
  active: "待機・実行中",
  attention: "停止・要確認",
  history: "終了した依頼",
  all: "すべての履歴",
} as const;
export type AuditRequestView = keyof typeof AUDIT_REQUEST_VIEWS;
type RequestStatus = typeof auditRequests.$inferSelect.status;
interface RequestRow {
  id: string;
  companyId: string;
  companyName: string;
  targetUrl: string;
  status: RequestStatus;
  message: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  started: boolean;
}
/** 全件から絞って20件ずつ返す。過去の失敗が解消後も要対応に残らないよう最新依頼だけを対象にする。 */
export async function listAuditRequests(
  db: DbOrTx,
  actor: Actor | null,
  input: { companyId?: string; view?: string; query?: string; page?: number } = {},
) {
  if (!(await isAuditOperator(db, actor))) return err("forbidden");
  const view = input.view ?? "open";
  if (
    !Object.hasOwn(AUDIT_REQUEST_VIEWS, view) ||
    (input.companyId && !UUID.test(input.companyId)) ||
    (input.query?.length ?? 0) > 200
  )
    return err("invalid_input");
  const query = input.query?.trim() ?? "";
  const base = sql`select r.id,r.company_id as "companyId",c.name as "companyName",r.target_url as "targetUrl",r.status,r.message,r.created_at as "createdAt",r.finished_at as "finishedAt",
 exists(select 1 from audit_events e where e.target_type='worker_step' and e.target_id='audit:'||r.company_id::text||':ops:'||r.id::text and e.action='worker.step_started') as started,
 (r.finished_at is not null and r.status in ('failed','blocked') and not exists(select 1 from audit_requests newer where newer.company_id=r.company_id and (newer.created_at,newer.id)>(r.created_at,r.id))) as attention
 from audit_requests r join companies c on c.id=r.company_id where true
 ${input.companyId ? sql`and r.company_id=${input.companyId}::uuid` : sql``}
 ${query ? sql`and position(lower(${query}) in lower(c.name||' '||r.target_url))>0` : sql``}`;
  const conditions = {
    open: sql`("finishedAt" is null or attention)`,
    active: sql`"finishedAt" is null`,
    attention: sql`attention`,
    history: sql`"finishedAt" is not null`,
    all: sql`true`,
  };
  const countsResult = await db.execute(
    sql`select count(*)::int as "all",count(*) filter(where "finishedAt" is null or attention)::int as "open",count(*) filter(where "finishedAt" is null)::int as "active",count(*) filter(where attention)::int as "attention",count(*) filter(where "finishedAt" is not null)::int as "history" from (${base}) candidates`,
  );
  const counts = (countsResult as { rows: Record<AuditRequestView, number>[] }).rows[0]!;
  const total = counts[view as AuditRequestView];
  const pages = Math.max(1, Math.ceil(total / 20));
  const page = Math.min(pages, Math.max(1, Number.isSafeInteger(input.page) ? input.page! : 1));
  const order =
    view === "history" || view === "all" ? sql`"createdAt" desc,id desc` : sql`attention desc,"createdAt" asc,id asc`;
  const result = await db.execute(
    sql`select * from (${base}) candidates where ${conditions[view as AuditRequestView]} order by ${order} limit 20 offset ${(page - 1) * 20}`,
  );
  return ok({
    view: view as AuditRequestView,
    query,
    counts,
    total,
    pages,
    page,
    items: (result as { rows: RequestRow[] }).rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      companyName: r.companyName,
      targetUrl: r.targetUrl,
      status: r.finishedAt ? r.status : r.started ? ("processing" as const) : ("queued" as const),
      message:
        !r.finishedAt && r.started
          ? "診断は開始済みです。追加の依頼は不要です。結果の反映をお待ちください。"
          : r.message,
      createdAt: new Date(r.createdAt).toISOString(),
      finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
      canCancel: !r.finishedAt && !r.started && r.status === "queued",
    })),
  });
}
/** 診断の開始と同じ実行キーをロックする。送信中でも開始前なら取り消せ、遅れて届いたジョブは前提照合で止まる。 */
export async function cancelAuditRequest(db: DbOrTx, clock: Clock, actor: Actor | null, requestId: string) {
  if (actor?.kind !== "ops" || !(await isAuditOperator(db, actor))) return err("forbidden", "運営だけが行える操作です");
  if (!UUID.test(requestId)) return err("invalid_input", "診断依頼を確認してください");
  const [initial] = await db.select().from(auditRequests).where(eq(auditRequests.id, requestId));
  if (!initial) return err("not_found", "診断依頼が見つかりません");
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, actor.userId)).for("update");
    if (user?.role !== "ops" || user.status !== "active") return err("forbidden", "操作権限を確認してください");
    const key = auditRequestKey(initial);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:step:${key}`}))`);
    const [r] = await tx.select().from(auditRequests).where(eq(auditRequests.id, requestId)).for("update");
    if (!r) return err("not_found");
    if (r.status === "cancelled") return ok({ companyId: r.companyId, alreadyCancelled: true });
    const state = await readStepState(tx, key);
    if (r.finishedAt || r.status !== "queued" || state.attempts > 0)
      return err("already_started", "診断が開始済み、または終了しています。最新の処理状況を確認してください。");
    await tx
      .update(auditRequests)
      .set({
        status: "cancelled",
        message: "運営が開始前の診断依頼を取り消しました。",
        finishedAt: clock.now(),
        updatedAt: clock.now(),
        leaseToken: null,
        leaseUntil: null,
      })
      .where(eq(auditRequests.id, requestId));
    await recordEvent(tx, clock, {
      actor,
      action: "audit.request_cancelled",
      targetType: "company",
      targetId: r.companyId,
      after: { requestId },
    });
    return ok({ companyId: r.companyId, alreadyCancelled: false });
  });
}
