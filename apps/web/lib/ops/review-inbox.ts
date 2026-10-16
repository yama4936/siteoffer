import { type Actor, err, ok } from "@siteoffer/core";
import { type DbOrTx, users } from "@siteoffer/db";
import { and, eq, sql } from "drizzle-orm";
import { isUuid } from "./form";
/** 全案件の最新版を検索する。提案本文・画像・内部の生成情報は一覧へ渡さない。 */
export async function getReviewInbox(
  db: DbOrTx,
  actor: Actor | null,
  input: { view?: string; query?: string; page?: number } = {},
) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden");
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  if (!user) return err("forbidden");
  const view = input.view ?? "pending";
  if (!["pending", "all"].includes(view) || (input.query?.length ?? 0) > 200) return err("invalid_input");
  const query = input.query?.trim() ?? "";
  const base = sql`select c.id,c.name,c.prefecture,c.city,c.industry,c.pipeline_status as status,c.suppression,
   v.id as "versionId",v.version,v.status as "versionStatus",coalesce(v.created_at,c.created_at) as since,
   coalesce(v.status='in_review' and c.suppression='none',false) as pending
   from companies c left join proposals p on p.company_id=c.id
   left join lateral(select id,version,status,created_at from proposal_versions where proposal_id=p.id order by version desc limit 1) v on true
   where true ${query ? sql`and position(lower(${query}) in lower(c.name||' '||coalesce(c.prefecture,'')||' '||coalesce(c.city,'')||' '||coalesce(c.industry,'')))>0` : sql``}`;
  const count = await db.execute(
    sql`select count(*)::int as "all",count(*) filter(where pending)::int as pending from (${base}) inbox`,
  );
  const counts = (count as { rows: { all: number; pending: number }[] }).rows[0]!;
  const total = view === "pending" ? counts.pending : counts.all;
  const pages = Math.max(1, Math.ceil(total / 20));
  const page = Math.min(pages, Math.max(1, Number.isSafeInteger(input.page) ? input.page! : 1));
  const result =
    await db.execute(sql`select * from (${base}) inbox where ${view === "pending" ? sql`pending` : sql`true`}
   order by pending desc,since asc,id asc limit 20 offset ${(page - 1) * 20}`);
  const rows = (
    result as {
      rows: {
        id: string;
        name: string;
        prefecture: string | null;
        city: string | null;
        industry: string | null;
        status: string;
        suppression: string;
        versionId: string | null;
        version: number | null;
        versionStatus: string | null;
        pending: boolean;
      }[];
    }
  ).rows;
  return ok({
    view: view as "pending" | "all",
    query,
    page,
    pages,
    total,
    counts,
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      location: [r.prefecture, r.city].filter(Boolean).join(" "),
      industry: r.industry,
      status: r.status,
      suppression: r.suppression,
      pending: r.pending,
      versionId: r.versionId,
      version: r.version,
      versionStatus: r.versionStatus,
    })),
  });
}
