import { type DbOrTx, productTerms, proposals, proposalVersions, salesOffers } from "@siteoffer/db";
import { and, desc, eq } from "drizzle-orm";

/** Caller authorizes company/assignment access. A pinned offer never falls back to another version. */
export async function getSalesOffer(db: DbOrTx, companyId: string, offerId?: string | null) {
  const [row] = await db
    .select({ offer: salesOffers, terms: productTerms, proposal: proposalVersions })
    .from(salesOffers)
    .innerJoin(productTerms, eq(productTerms.id, salesOffers.productTermsId))
    .innerJoin(proposalVersions, eq(proposalVersions.id, salesOffers.proposalVersionId))
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .where(
      and(
        eq(salesOffers.companyId, companyId),
        eq(proposals.companyId, companyId),
        offerId ? eq(salesOffers.id, offerId) : undefined,
      ),
    )
    .orderBy(desc(salesOffers.version))
    .limit(1);
  return row ?? null;
}
