import { type Actor, can } from "@siteoffer/core";
import { assignments, companies, type DbOrTx, salesActivities, users } from "@siteoffer/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import {
  type ActivityHistoryFilters,
  type ActivityHistoryPage,
  DEFAULT_ACTIVITY_HISTORY,
  normalizeActivityHistoryFilters,
} from "./activity-history-types";
import { isUuid } from "./ops/form";

export class ActivityHistoryError extends Error {
  readonly code: "invalid_input" | "forbidden" | "not_found";
  constructor(code: "invalid_input" | "forbidden" | "not_found") {
    super("活動履歴を確認できません");
    this.code = code;
  }
}
/** Read only the selected page. Search never reads private working copies or other assignments. */
export async function readActivityHistory(
  db: DbOrTx,
  actor: Actor | null,
  assignmentId: string,
  input: ActivityHistoryFilters = DEFAULT_ACTIVITY_HISTORY,
): Promise<ActivityHistoryPage> {
  if (!actor || (actor.kind !== "sales" && actor.kind !== "ops") || !isUuid(actor.userId))
    throw new ActivityHistoryError("forbidden");
  if (!isUuid(assignmentId)) throw new ActivityHistoryError("not_found");
  const filters = normalizeActivityHistoryFilters(input);
  if (!filters) throw new ActivityHistoryError("invalid_input");
  return db.transaction(
    async (tx) => {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, actor.userId), eq(users.role, actor.kind), eq(users.status, "active")));
      if (!user) throw new ActivityHistoryError("forbidden");
      const [assignment] = await tx
        .select({
          id: assignments.id,
          companyId: assignments.companyId,
          companyName: companies.name,
          salesName: users.displayName,
          status: assignments.status,
          owner: assignments.userId,
        })
        .from(assignments)
        .innerJoin(companies, eq(companies.id, assignments.companyId))
        .innerJoin(users, eq(users.id, assignments.userId))
        .where(eq(assignments.id, assignmentId));
      if (!assignment || !can(actor, "read", { type: "salesActivity", ownerUserId: assignment.owner }))
        throw new ActivityHistoryError("not_found");
      const base = eq(salesActivities.assignmentId, assignmentId);
      const where = and(
        base,
        filters.kind === "all" ? undefined : eq(salesActivities.kind, filters.kind),
        filters.consultations === "only" ? eq(salesActivities.consultOps, true) : undefined,
        filters.query
          ? sql`position(lower(${filters.query}) in lower(coalesce(${salesActivities.note},'')))>0`
          : undefined,
      );
      const [counts] = await tx
        .select({
          allTotal: sql<number>`count(*)`.mapWith(Number),
          total: sql<number>`count(*) filter(where ${where})`.mapWith(Number),
          consultations: sql<number>`count(*) filter(where ${salesActivities.consultOps})`.mapWith(Number),
        })
        .from(salesActivities)
        .where(base);
      const total = counts!.total,
        pageCount = Math.max(1, Math.ceil(total / 20)),
        page = Math.min(filters.page, pageCount);
      const rows = await tx
        .select({
          id: salesActivities.id,
          kind: salesActivities.kind,
          occurredAt: salesActivities.occurredAt,
          note: salesActivities.note,
          nextActionAt: salesActivities.nextActionAt,
          nextActionMode: salesActivities.nextActionMode,
          consultOps: salesActivities.consultOps,
        })
        .from(salesActivities)
        .where(where)
        .orderBy(desc(salesActivities.occurredAt), desc(salesActivities.id))
        .limit(20)
        .offset((page - 1) * 20);
      const [latest] = await tx
        .select({ note: salesActivities.note })
        .from(salesActivities)
        .where(and(base, ne(salesActivities.note, "")))
        .orderBy(desc(salesActivities.occurredAt), desc(salesActivities.id))
        .limit(1);
      const { owner: _owner, ...context } = assignment;
      return {
        assignment: context,
        filters: { ...filters, page },
        items: rows.map((r) => ({
          ...r,
          occurredAt: r.occurredAt.toISOString(),
          nextActionAt: r.nextActionAt?.toISOString() ?? null,
        })),
        total,
        allTotal: counts!.allTotal,
        pageCount,
        pageSize: 20,
        hasConsultations: counts!.consultations > 0,
        latestNote: latest?.note ?? null,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}
