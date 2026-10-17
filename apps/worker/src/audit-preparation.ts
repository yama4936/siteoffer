import { type Actor, type Clock, err, ok } from "@siteoffer/core";
import type { DbOrTx } from "@siteoffer/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { isAuditOperator, requestAuditByOps, salesHistoryExists } from "./audit-request.ts";
import { checkPublicHttpUrl } from "./url.ts";

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** まだ診断を依頼していない公式確認済み企業。意図的な取消や診断済み案件を準備待ちへ戻さない。 */
export async function listAuditPreparation(
  db: DbOrTx,
  actor: Actor | null,
  input: { companyId?: string; query?: string; page?: number; offset?: number; limit?: number } = {},
) {
  if (!(await isAuditOperator(db, actor))) return err("forbidden");
  if ((input.companyId && !UUID.test(input.companyId)) || (input.query?.length ?? 0) > 200) return err("invalid_input");
  if (
    input.offset !== undefined &&
    (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 2147483647)
  )
    return err("invalid_input");
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500))
    return err("invalid_input");
  const query = input.query?.trim() ?? "";
  const exists = await db.execute(sql`select to_regclass('pgboss.job') is not null as present`);
  const hasQueue = (exists as { rows: { present: boolean }[] }).rows[0]?.present;
  const base = sql`select c.id,c.name,c.updated_at as "createdAt",w.id as "websiteId",w.url
    from companies c left join lateral (select id,url from websites where company_id=c.id and kind='current'
      order by is_primary desc,created_at asc limit 1) w on true
    where c.suppression='none' and c.official_site_status='confirmed' and c.pipeline_status in ('collected','site_confirmed')
      and not ${salesHistoryExists(sql`c.id`)}
      and not exists(select 1 from audit_requests r where r.company_id=c.id)
      and not exists(select 1 from site_audits a where a.company_id=c.id)
      and not exists(select 1 from design_versions d where d.company_id=c.id)
      and not exists(select 1 from proposal_handoffs h where h.company_id=c.id)
      ${
        hasQueue
          ? sql`and not exists(select 1 from pgboss.job j where j.name in ('pipeline.audit','pipeline.proposal')
        and j.data->>'companyId'=c.id::text and j.state in ('created','retry','active'))`
          : sql``
      }
      ${input.companyId ? sql`and c.id=${input.companyId}::uuid` : sql``}
      ${query ? sql`and position(lower(${query}) in lower(c.name||' '||coalesce(w.url,'')))>0` : sql``}`;
  const count = await db.execute(sql`select count(*)::int total from (${base}) candidates`);
  const total = (count as { rows: { total: number }[] }).rows[0]!.total;
  const pages = Math.max(1, Math.ceil(total / 20));
  const page = Math.min(pages, Math.max(1, Number.isSafeInteger(input.page) ? input.page! : 1));
  const result = await db.execute(
    sql`${base} order by date_trunc('milliseconds', c.updated_at) asc,c.id asc limit ${input.limit ?? 20} offset ${input.offset ?? (page - 1) * 20}`,
  );
  return ok({
    total,
    pages,
    page,
    query,
    items: (
      result as { rows: { id: string; name: string; createdAt: Date; websiteId: string | null; url: string | null }[] }
    ).rows.map((r) => {
      const checked = r.url ? checkPublicHttpUrl(r.url) : null;
      return {
        companyId: r.id,
        companyName: r.name,
        createdAt: new Date(r.createdAt).toISOString(),
        websiteId: r.websiteId,
        targetUrl: checked?.ok ? checked.url.href : null,
        blockedReason: checked?.ok ? null : "診断できる公開HTTP/HTTPSの公式サイトを登録してください。",
      };
    }),
  });
}
const batchSchema = z
  .array(
    z
      .object({
        companyId: z
          .string()
          .regex(UUID)
          .transform((id) => id.toLowerCase()),
        requestId: z
          .string()
          .regex(UUID)
          .transform((id) => id.toLowerCase()),
        websiteId: z
          .string()
          .regex(UUID)
          .transform((id) => id.toLowerCase()),
        targetUrl: z.string().max(4096),
      })
      .strict(),
  )
  .min(1)
  .max(20);
export type AuditPreparationSelection = z.infer<typeof batchSchema>;
/** 各企業を独立して受け付ける。同じ操作IDを再送しても受付は重複しない。 */
export async function requestPreparedAudits(db: DbOrTx, clock: Clock, actor: Actor | null, input: unknown) {
  if (!(await isAuditOperator(db, actor))) return err("forbidden", "操作権限を確認してください。");
  const parsed = batchSchema.safeParse(input);
  if (
    !parsed.success ||
    new Set(parsed.data.map((r) => r.companyId)).size !== parsed.data.length ||
    new Set(parsed.data.map((r) => r.requestId)).size !== parsed.data.length ||
    parsed.data.some((r) => !checkPublicHttpUrl(r.targetUrl).ok)
  )
    return err("invalid_input", "対象を1〜20社選び、公式サイトを確認してください。");
  const items: { companyId: string; requestId: string; ok: boolean; message: string }[] = [];
  for (const item of parsed.data) {
    try {
      const result = await requestAuditByOps(db, clock, actor, {
        companyId: item.companyId,
        requestId: item.requestId,
        initialOnly: true,
        expectedTarget: { websiteId: item.websiteId, url: item.targetUrl },
      });
      items.push({
        companyId: item.companyId,
        requestId: item.requestId,
        ok: result.ok,
        message: result.ok
          ? result.value.alreadyAccepted
            ? "受付済みの依頼を確認しました。"
            : "診断を受け付けました。"
          : (result.message ?? "対象と現在の状態を確認してください。"),
      });
    } catch {
      items.push({
        companyId: item.companyId,
        requestId: item.requestId,
        ok: false,
        message: "受付結果を確認できません。同じ選択で再度操作するか、診断依頼の一覧を確認してください。",
      });
    }
  }
  return ok({ items });
}
