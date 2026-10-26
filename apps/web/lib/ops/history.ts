import { type Actor, err, ok } from "@siteoffer/core";
import { auditEvents, companies, type DbOrTx, users } from "@siteoffer/db";
import { and, count, desc, eq, gte, ilike, inArray, lt, not, or, sql } from "drizzle-orm";
import { isUuid } from "./form.ts";
import { historyFields, historyMatchingActions } from "./history-presentation.ts";
import { type HistoryQuery, historyDate, parseHistoryQuery } from "./history-query.ts";

const metadata = {
  id: auditEvents.id,
  actorKind: sql<string>`left(${auditEvents.actorKind},40)`,
  actorName: sql<string | null>`left(${users.displayName},120)`,
  action: sql<string>`left(${auditEvents.action},180)`,
  targetType: sql<string>`left(${auditEvents.targetType},120)`,
  targetId: sql<string>`left(${auditEvents.targetId},300)`,
  targetTruncated: sql<boolean>`length(${auditEvents.targetId})>300`,
  createdAt: auditEvents.createdAt,
  companyName: sql<string | null>`left(${companies.name},200)`,
};
const joinCompany = and(eq(auditEvents.targetType, "company"), eq(auditEvents.targetId, sql`${companies.id}::text`));
const literal = (value: string) => value.replace(/[\\%_]/g, "\\$&");
async function activeOperator(db: DbOrTx, actor: Actor | null) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return false;
  return !!(
    await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")))
  )[0];
}
export async function readAuditHistory(db: DbOrTx, actor: Actor | null, input: HistoryQuery) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden");
  if (!input || typeof input !== "object") return err("invalid_input");
  const q = parseHistoryQuery({ ...input, page: typeof input.page === "number" ? String(input.page) : input.page });
  if (!q) return err("invalid_input");
  return db.transaction(
    async (tx) => {
      if (!(await activeOperator(tx, actor))) return err("forbidden");
      const term = `%${literal(q.q)}%`,
        actions = q.q ? historyMatchingActions(q.q) : [];
      const condition = and(
        q.q
          ? or(
              ...[
                auditEvents.id,
                auditEvents.action,
                auditEvents.targetType,
                auditEvents.targetId,
                users.displayName,
                companies.name,
              ].map((column) => ilike(sql`${column}::text`, term)),
              actions.length ? inArray(auditEvents.action, actions) : undefined,
            )
          : undefined,
        q.action ? ilike(auditEvents.action, `${literal(q.action)}%`) : undefined,
        q.targetType ? eq(auditEvents.targetType, q.targetType) : undefined,
        q.targetId ? eq(auditEvents.targetId, q.targetId) : undefined,
        q.actor ? eq(auditEvents.actorKind, q.actor) : undefined,
        q.from ? gte(auditEvents.createdAt, historyDate(q.from)!) : undefined,
        q.to ? lt(auditEvents.createdAt, new Date(historyDate(q.to)!.getTime() + 86_400_000)) : undefined,
      );
      const access = inArray(auditEvents.action, ["session.created", "session.deleted"]);
      const [found] = await tx
        .select({ total: count(), access: sql<number>`count(*) filter(where ${access})`.mapWith(Number) })
        .from(auditEvents)
        .leftJoin(users, eq(users.id, auditEvents.actorId))
        .leftJoin(companies, joinCompany)
        .where(condition);
      const counts = { all: found!.total, access: found!.access, work: found!.total - found!.access };
      const total = counts[q.view],
        pages = Math.max(1, Math.ceil(total / 20)),
        page = Math.min(q.page, pages);
      const rows = await tx
        .select(metadata)
        .from(auditEvents)
        .leftJoin(users, eq(users.id, auditEvents.actorId))
        .leftJoin(companies, joinCompany)
        .where(and(condition, q.view === "all" ? undefined : q.view === "access" ? access : not(access)))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(20)
        .offset((page - 1) * 20);
      return ok({
        query: { ...q, page },
        total,
        counts,
        pages,
        items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      });
    },
    { isolationLevel: "repeatable read" },
  );
}
export async function readAuditHistoryEvent(db: DbOrTx, actor: Actor | null, id: string) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden");
  if (!isUuid(id)) return err("invalid_input");
  return db.transaction(
    async (tx) => {
      if (!(await activeOperator(tx, actor))) return err("forbidden");
      const bounded = (column: typeof auditEvents.before | typeof auditEvents.after) =>
        sql<unknown>`case when octet_length(${column}::text)<=65536 then ${column} else null end`;
      const [row] = await tx
        .select({
          ...metadata,
          before: bounded(auditEvents.before),
          after: bounded(auditEvents.after),
          beforeOmitted: sql<boolean>`coalesce(octet_length(${auditEvents.before}::text)>65536,false)`,
          afterOmitted: sql<boolean>`coalesce(octet_length(${auditEvents.after}::text)>65536,false)`,
        })
        .from(auditEvents)
        .leftJoin(users, eq(users.id, auditEvents.actorId))
        .leftJoin(companies, joinCompany)
        .where(eq(auditEvents.id, id));
      if (!row) return err("not_found");
      const { before, after, ...summary } = row;
      return ok({ ...summary, createdAt: row.createdAt.toISOString(), fields: historyFields(before, after) });
    },
    { isolationLevel: "repeatable read" },
  );
}
export type HistoryPage = Extract<Awaited<ReturnType<typeof readAuditHistory>>, { ok: true }>["value"];
