import { type Actor, err, ok } from "@siteoffer/core";
import { companies, contracts, type DbOrTx, rewards, users } from "@siteoffer/db";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { attachContractFinancials } from "./contract-financials";
import { type ContractLedgerFilters, normalizeContractLedgerFilters } from "./contract-ledger-filters";
import { isUuid } from "./form";

export const CONTRACT_LEDGER_PAGE_SIZE = 25;
export type ContractsLedger = Extract<Awaited<ReturnType<typeof getContractsLedger>>, { ok: true }>["value"];

/** Search/count the full ledger, then read finances for one page in the same snapshot. */
export async function getContractsLedger(db: DbOrTx, actor: Actor | null, input: Partial<ContractLedgerFilters> = {}) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden");
  const filters = normalizeContractLedgerFilters(input);
  if (!filters) return err("invalid_input");
  return db.transaction(
    async (tx) => {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
      if (!user) return err("forbidden");
      const where = and(
        filters.focus ? eq(contracts.id, filters.focus) : undefined,
        filters.q
          ? sql`position(lower(${filters.q}) in lower(${companies.name} || ' ' || ${users.displayName} || ' ' || ${contracts.id}::text)) > 0`
          : undefined,
        filters.status === "pending"
          ? inArray(contracts.status, ["reported", "under_review"])
          : filters.status !== "all"
            ? eq(contracts.status, filters.status)
            : undefined,
        filters.reward === "unpaid"
          ? inArray(rewards.status, ["accrued", "scheduled"])
          : filters.reward === "none"
            ? isNull(rewards.id)
            : filters.reward !== "all"
              ? eq(rewards.status, filters.reward)
              : undefined,
      );
      const [counts] = await tx
        .select({
          total: count(),
          pending: sql<number>`count(*) filter(where ${contracts.status} in ('reported','under_review'))`.mapWith(
            Number,
          ),
          unpaid: sql<number>`count(*) filter(where ${rewards.status} in ('accrued','scheduled'))`.mapWith(Number),
        })
        .from(contracts)
        .innerJoin(companies, eq(companies.id, contracts.companyId))
        .innerJoin(users, eq(users.id, contracts.salesUserId))
        .leftJoin(rewards, eq(rewards.contractId, contracts.id))
        .where(where);
      const total = counts?.total ?? 0;
      const pages = Math.max(1, Math.ceil(total / CONTRACT_LEDGER_PAGE_SIZE));
      const page = Math.min(filters.page, pages);
      const order = filters.sort === "oldest" ? asc(contracts.reportedAt) : desc(contracts.reportedAt);
      const rows = await tx
        .select({ c: contracts, companyName: companies.name, salesName: users.displayName })
        .from(contracts)
        .innerJoin(companies, eq(companies.id, contracts.companyId))
        .innerJoin(users, eq(users.id, contracts.salesUserId))
        .leftJoin(rewards, eq(rewards.contractId, contracts.id))
        .where(where)
        .orderBy(
          ...(filters.sort === "attention"
            ? [
                sql`case when ${contracts.status} in ('reported','under_review') then 0 when ${rewards.status} in ('accrued','scheduled') then 1 else 2 end`,
              ]
            : []),
          order,
          asc(contracts.id),
        )
        .limit(CONTRACT_LEDGER_PAGE_SIZE)
        .offset((page - 1) * CONTRACT_LEDGER_PAGE_SIZE);
      return ok({
        rows: await attachContractFinancials(tx, rows),
        total,
        pending: counts?.pending ?? 0,
        unpaid: counts?.unpaid ?? 0,
        pages,
        page,
        pageSize: CONTRACT_LEDGER_PAGE_SIZE,
        filters: { ...filters, page },
      });
    },
    { isolationLevel: "repeatable read" },
  );
}
