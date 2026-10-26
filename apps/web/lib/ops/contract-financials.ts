import { getRewardSummariesForContracts } from "@siteoffer/core";
import { type contracts, type DbOrTx, payments } from "@siteoffer/db";
import { asc, inArray } from "drizzle-orm";

type ContractRow = { c: typeof contracts.$inferSelect; companyName: string; salesName: string };

/** Only attach data for the authorized rows on this page. No per-contract query loop. */
export async function attachContractFinancials(db: DbOrTx, rows: ContractRow[]) {
  const ids = rows.map((row) => row.c.id);
  const paid = ids.length
    ? await db
        .select()
        .from(payments)
        .where(inArray(payments.contractId, ids))
        .orderBy(asc(payments.createdAt), asc(payments.id))
    : [];
  const summaries = await getRewardSummariesForContracts(db, ids);
  return rows.map((row) => ({
    ...row,
    payments: paid.filter((payment) => payment.contractId === row.c.id),
    reward: summaries.get(row.c.id) ?? null,
  }));
}
