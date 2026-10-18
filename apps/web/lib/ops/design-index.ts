import { type Actor, err, ok } from "@siteoffer/core";
import { companies, type DbOrTx, designVersions, users } from "@siteoffer/db";
import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { type DesignIndexQuery, designIndexParams, parseDesignIndexQuery } from "./design-index-query";
import { isUuid } from "./form";

const PAGE_SIZE = 20;
export async function readDesignIndex(db: DbOrTx, actor: Actor | null, input: DesignIndexQuery) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden");
  const query = parseDesignIndexQuery(Object.fromEntries(designIndexParams(input)));
  if (!query) return err("invalid_input");
  return db.transaction(
    async (tx) => {
      const [active] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
      if (!active) return err("forbidden");
      const pattern = `%${query.companyQuery.replace(/[\\%_]/g, "\\$&")}%`;
      const where = query.companyQuery
        ? or(ilike(companies.name, pattern), ilike(companies.prefecture, pattern), ilike(companies.city, pattern))
        : undefined;
      const [companyCount] = await tx.select({ total: count() }).from(companies).where(where);
      const companyPages = Math.max(1, Math.ceil(companyCount!.total / PAGE_SIZE)),
        companyPage = Math.min(query.companyPage, companyPages);
      const companyItems = await tx
        .select({ id: companies.id, name: companies.name, prefecture: companies.prefecture, city: companies.city })
        .from(companies)
        .where(where)
        .orderBy(desc(companies.updatedAt), desc(companies.id))
        .limit(PAGE_SIZE)
        .offset((companyPage - 1) * PAGE_SIZE);
      const listing = { items: companyItems, total: companyCount!.total, page: companyPage, pages: companyPages };
      const companyId = query.companyId ?? companyItems[0]?.id;
      const [company] = companyId
        ? await tx.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, companyId))
        : [];
      if (companyId && !company) return err("not_found");
      const historyWhere = company
        ? and(
            eq(designVersions.companyId, company.id),
            query.historyState === "all" ? undefined : eq(designVersions.status, query.historyState),
          )
        : undefined;
      const [historyCount] = company
        ? await tx.select({ total: count() }).from(designVersions).where(historyWhere)
        : [{ total: 0 }];
      const historyPages = Math.max(1, Math.ceil(historyCount!.total / PAGE_SIZE)),
        historyPage = Math.min(query.historyPage, historyPages);
      const historyItems = company
        ? await tx
            .select({ id: designVersions.id, version: designVersions.version, status: designVersions.status })
            .from(designVersions)
            .where(historyWhere)
            .orderBy(desc(designVersions.version))
            .limit(PAGE_SIZE)
            .offset((historyPage - 1) * PAGE_SIZE)
        : [];
      // The editor selection is independent of searches, status filters, and list pages.
      const [latest] =
        company && !query.designId
          ? await tx
              .select({ id: designVersions.id })
              .from(designVersions)
              .where(eq(designVersions.companyId, company.id))
              .orderBy(desc(designVersions.version))
              .limit(1)
          : [];
      const selectedId = query.designId === "new" ? null : (query.designId ?? latest?.id);
      const [selected] =
        company && selectedId
          ? await tx
              .select({
                id: designVersions.id,
                companyId: designVersions.companyId,
                version: designVersions.version,
                status: designVersions.status,
                brief: designVersions.brief,
                imageSha256: designVersions.imageSha256,
                width: designVersions.width,
                height: designVersions.height,
                error: designVersions.error,
                reviewNote: designVersions.reviewNote,
                buildRequestedAt: designVersions.buildRequestedAt,
                source: designVersions.source,
                model: designVersions.model,
              })
              .from(designVersions)
              .where(and(eq(designVersions.id, selectedId), eq(designVersions.companyId, company.id)))
          : [];
      if (selectedId && !selected) return err("not_found");
      return ok({
        company: company ?? null,
        companies: listing,
        history: { items: historyItems, total: historyCount!.total, page: historyPage, pages: historyPages },
        selected: selected ?? null,
        query: { ...query, companyId: company?.id ?? null, companyPage, historyPage },
      });
    },
    { isolationLevel: "repeatable read" },
  );
}
export type DesignIndex = Extract<Awaited<ReturnType<typeof readDesignIndex>>, { ok: true }>["value"];
