import { type Actor, err, ok } from "@siteoffer/core";
import { companies, type DbOrTx, discoveryJobs, discoverySources, users } from "@siteoffer/db";
import { and, count, desc, eq, exists, ilike, ne, or, sql } from "drizzle-orm";
import { type DiscoveryIndexQuery, discoveryIndexParams, parseDiscoveryIndexQuery } from "./discovery-index-query";
import { isUuid } from "./form";

const literal = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
const criteriaField = (key: string, length = 80) =>
  sql<string | null>`left(${discoveryJobs.criteria}->>${key}, ${length})`;
export async function readDiscoveryIndex(db: DbOrTx, actor: Actor | null, input: DiscoveryIndexQuery) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden");
  const query = parseDiscoveryIndexQuery(Object.fromEntries(discoveryIndexParams(input)));
  if (!query) return err("invalid_input");
  return db.transaction(
    async (tx) => {
      const [active] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
      if (!active) return err("forbidden");
      const [sourceJob] = query.sourceJob
        ? await tx
            .select({ id: discoveryJobs.id, provider: discoveryJobs.provider, createdAt: discoveryJobs.createdAt })
            .from(discoveryJobs)
            .where(eq(discoveryJobs.id, query.sourceJob))
        : [];
      if (query.sourceJob && !sourceJob) return err("not_found");
      const companyWhere = and(
        query.q
          ? or(
              ...[
                companies.name,
                companies.corporateNumber,
                companies.prefecture,
                companies.city,
                companies.industry,
              ].map((column) => ilike(column, literal(query.q))),
            )
          : undefined,
        query.prefecture ? eq(companies.prefecture, query.prefecture) : undefined,
        query.city ? ilike(companies.city, `${query.city.replace(/[\\%_]/g, "\\$&")}%`) : undefined,
        query.official
          ? eq(companies.officialSiteStatus, query.official as (typeof companies.$inferSelect)["officialSiteStatus"])
          : undefined,
        query.pipeline
          ? eq(companies.pipelineStatus, query.pipeline as (typeof companies.$inferSelect)["pipelineStatus"])
          : undefined,
        query.suppressed === "yes"
          ? ne(companies.suppression, "none")
          : query.suppressed === "no"
            ? eq(companies.suppression, "none")
            : undefined,
        query.sourceJob
          ? exists(
              tx
                .select({ id: discoverySources.id })
                .from(discoverySources)
                .where(and(eq(discoverySources.companyId, companies.id), eq(discoverySources.jobId, query.sourceJob))),
            )
          : undefined,
      );
      const [companyCount] = await tx.select({ total: count() }).from(companies).where(companyWhere);
      const companyPages = Math.max(1, Math.ceil(companyCount!.total / 20)),
        companyPage = Math.min(query.companyPage, companyPages);
      const companyItems = await tx
        .select({
          id: companies.id,
          name: companies.name,
          corporateNumber: companies.corporateNumber,
          prefecture: companies.prefecture,
          city: companies.city,
          industry: companies.industry,
          addressHasSource: sql<boolean>`${companies.addressSourceUrl} is not null`,
          officialSiteStatus: companies.officialSiteStatus,
          pipelineStatus: companies.pipelineStatus,
          suppression: companies.suppression,
          updatedAt: companies.updatedAt,
        })
        .from(companies)
        .where(companyWhere)
        .orderBy(desc(companies.updatedAt), desc(companies.id))
        .limit(20)
        .offset((companyPage - 1) * 20);
      const jobWhere = and(
        query.jobProvider ? eq(discoveryJobs.provider, query.jobProvider) : undefined,
        query.jobStatus ? eq(discoveryJobs.status, query.jobStatus) : undefined,
        query.jobQuery
          ? or(
              ilike(sql`${discoveryJobs.id}::text`, literal(query.jobQuery)),
              ilike(discoveryJobs.provider, literal(query.jobQuery)),
              ...["prefecture", "city", "cityCode", "industry", "keywords"].map((key) =>
                ilike(sql`${discoveryJobs.criteria}->>${key}`, literal(query.jobQuery)),
              ),
            )
          : undefined,
      );
      const [jobCount] = await tx.select({ total: count() }).from(discoveryJobs).where(jobWhere);
      const jobsPages = Math.max(1, Math.ceil(jobCount!.total / 20)),
        jobsPage = Math.min(query.jobsPage, jobsPages);
      const jobItems = await tx
        .select({
          id: discoveryJobs.id,
          provider: discoveryJobs.provider,
          status: discoveryJobs.status,
          foundCount: discoveryJobs.foundCount,
          createdCount: discoveryJobs.createdCount,
          updatedCount: discoveryJobs.updatedCount,
          skippedCount: discoveryJobs.skippedCount,
          failedCount: discoveryJobs.failedCount,
          attempts: discoveryJobs.attempts,
          createdAt: discoveryJobs.createdAt,
          finishedAt: discoveryJobs.finishedAt,
          hasError: sql<boolean>`${discoveryJobs.error} is not null`,
          failureCount: sql<number>`case when jsonb_typeof(${discoveryJobs.failures}) = 'array' then jsonb_array_length(${discoveryJobs.failures}) else 0 end`,
          condition: {
            prefecture: criteriaField("prefecture"),
            city: criteriaField("city"),
            cityCode: criteriaField("cityCode", 5),
            industry: criteriaField("industry"),
            limit: criteriaField("limit", 12),
            keywords: sql<
              string | null
            >`case when jsonb_typeof(${discoveryJobs.criteria}->'keywords') = 'array' then (select string_agg(left(term.value,80),'・') from (select value from jsonb_array_elements_text(${discoveryJobs.criteria}->'keywords') limit 10) term) else null end`,
          },
        })
        .from(discoveryJobs)
        .where(jobWhere)
        .orderBy(desc(discoveryJobs.createdAt), desc(discoveryJobs.id))
        .limit(20)
        .offset((jobsPage - 1) * 20);
      return ok({
        companies: { items: companyItems, total: companyCount!.total, page: companyPage, pages: companyPages },
        jobs: { items: jobItems, total: jobCount!.total, page: jobsPage, pages: jobsPages },
        sourceJob: sourceJob ?? null,
        query: { ...query, companyPage, jobsPage },
      });
    },
    { isolationLevel: "repeatable read" },
  );
}
export type DiscoveryIndex = Extract<Awaited<ReturnType<typeof readDiscoveryIndex>>, { ok: true }>["value"];
