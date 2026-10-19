import { type Actor, err, ok } from "@siteoffer/core";
import { companies, type DbOrTx, findings, siteAudits, users } from "@siteoffer/db";
import { and, asc, count, desc, eq, lt, or, sql } from "drizzle-orm";
import { compareAudits } from "./audit-comparison";
import { type AuditHistoryQuery, parseAuditHistoryQuery } from "./audit-history-query";
import { isUuid } from "./form";

export const AUDIT_HISTORY_PAGE_SIZE = 25;
const metadata = {
  id: siteAudits.id,
  createdAt: siteAudits.createdAt,
  status: siteAudits.status,
  targetUrl: siteAudits.targetUrl,
  totalScore: siteAudits.totalScore,
  coverage: siteAudits.coverage,
  scoreConfirmed: siteAudits.scoreConfirmed,
  decision: siteAudits.decision,
};
const safeAudit = {
  ...metadata,
  companyId: siteAudits.companyId,
  websiteId: siteAudits.websiteId,
  finalUrl: siteAudits.finalUrl,
  rubricVersion: siteAudits.rubricVersion,
  criticalFlags: siteAudits.criticalFlags,
  summary: siteAudits.summary,
  decisionReason: siteAudits.decisionReason,
  unevaluableReason: siteAudits.unevaluableReason,
  failureReason: siteAudits.failureReason,
  evaluatorModel: siteAudits.evaluatorModel,
  attempts: siteAudits.attempts,
  fetchedAt: siteAudits.fetchedAt,
  evaluatedAt: siteAudits.evaluatedAt,
  updatedAt: siteAudits.updatedAt,
};
const findingSummary = {
  itemCode: findings.itemCode,
  category: findings.category,
  status: findings.status,
  score: findings.score,
  reason: findings.reason,
  improvementHint: findings.improvementHint,
  critical: findings.critical,
  inference: findings.inference,
};

/** The company, selected result, matching history and comparison share one read snapshot. */
export async function getCompanyAuditHistory(
  db: DbOrTx,
  actor: Actor | null,
  companyId: string,
  input: AuditHistoryQuery,
) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden");
  if (!isUuid(companyId)) return err("not_found");
  if (!input || typeof input !== "object" || Array.isArray(input)) return err("invalid_input");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, String(value));
  const query = parseAuditHistoryQuery(params);
  if (!query) return err("invalid_input");
  return db.transaction(
    async (tx) => {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
      if (!user) return err("forbidden");
      const [company] = await tx
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId));
      if (!company) return err("not_found");
      const where = and(
        eq(siteAudits.companyId, company.id),
        query.status === "all" ? undefined : eq(siteAudits.status, query.status),
      );
      const [counts] = await tx
        .select({
          total: count(),
          matching:
            sql<number>`count(*) filter(where ${query.status === "all" ? sql`true` : sql`${siteAudits.status}=${query.status}`})`.mapWith(
              Number,
            ),
        })
        .from(siteAudits)
        .where(eq(siteAudits.companyId, company.id));
      const total = counts?.matching ?? 0,
        pages = Math.max(1, Math.ceil(total / AUDIT_HISTORY_PAGE_SIZE)),
        page = Math.min(query.page, pages);
      const order = query.sort === "newest" ? desc : asc;
      const items = await tx
        .select(metadata)
        .from(siteAudits)
        .where(where)
        .orderBy(order(siteAudits.createdAt), order(siteAudits.id))
        .limit(AUDIT_HISTORY_PAGE_SIZE)
        .offset((page - 1) * AUDIT_HISTORY_PAGE_SIZE);
      const selectedId = query.audit ?? items[0]?.id;
      const [selected] = selectedId
        ? await tx
            .select(safeAudit)
            .from(siteAudits)
            .where(and(eq(siteAudits.companyId, company.id), eq(siteAudits.id, selectedId)))
        : [];
      if (selectedId && !selected) return err("not_found");
      const selectedFindings = selected
        ? await tx.select().from(findings).where(eq(findings.auditId, selected.id)).orderBy(asc(findings.itemCode))
        : [];
      const [previous] = selected
        ? await tx
            .select(safeAudit)
            .from(siteAudits)
            .where(
              and(
                eq(siteAudits.companyId, company.id),
                eq(siteAudits.websiteId, selected.websiteId),
                eq(siteAudits.targetUrl, selected.targetUrl),
                eq(siteAudits.status, "evaluated"),
                or(
                  lt(siteAudits.createdAt, selected.createdAt),
                  and(eq(siteAudits.createdAt, selected.createdAt), lt(siteAudits.id, selected.id)),
                ),
              ),
            )
            .orderBy(desc(siteAudits.createdAt), desc(siteAudits.id))
            .limit(1)
        : [];
      const previousFindings = previous
        ? await tx
            .select(findingSummary)
            .from(findings)
            .where(eq(findings.auditId, previous.id))
            .orderBy(asc(findings.itemCode))
        : [];
      return ok({
        company,
        items,
        total,
        allTotal: counts?.total ?? 0,
        pages,
        page,
        pageSize: AUDIT_HISTORY_PAGE_SIZE,
        query: { ...query, page },
        selected: selected ?? null,
        selectedFindings,
        selectedOutsideFilter: !!selected && query.status !== "all" && selected.status !== query.status,
        previous: previous ?? null,
        comparison: selected && previous ? compareAudits(selected, previous, selectedFindings, previousFindings) : null,
      });
    },
    { isolationLevel: "repeatable read" },
  );
}
export type CompanyAuditHistory = Extract<Awaited<ReturnType<typeof getCompanyAuditHistory>>, { ok: true }>["value"];
