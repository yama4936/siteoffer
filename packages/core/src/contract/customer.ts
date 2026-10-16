import { contracts, type DbOrTx } from "@siteoffer/db";
import { and, eq, inArray, ne, type SQLWrapper, sql } from "drizzle-orm";

/** 契約確認中・契約済みの企業は、新しい営業候補に戻さない。制作工程や営業抑止とは別に判定する。 */
export function hasSalesContract(companyId: SQLWrapper) {
  return sql<boolean>`exists(select 1 from contracts customer_contract where customer_contract.company_id=${companyId} and customer_contract.status in ('reported','under_review','completed'))`;
}

/** 確認中も含めて新規営業を止める。契約の担当行ロックと有効担当の一意制約で重複報告・確定を防ぐ。 */
export async function findSalesContract(
  db: DbOrTx,
  companyId: string,
  options: { exceptId?: string; completedOnly?: boolean } = {},
) {
  const [contract] = await db
    .select({ id: contracts.id, status: contracts.status })
    .from(contracts)
    .where(
      and(
        eq(contracts.companyId, companyId),
        options.completedOnly
          ? eq(contracts.status, "completed")
          : inArray(contracts.status, ["reported", "under_review", "completed"]),
        options.exceptId ? ne(contracts.id, options.exceptId) : undefined,
      ),
    )
    .limit(1);
  return contract;
}
