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
        offerId ? eq(salesOffers.id, offerId) : eq(salesOffers.isPublic, true),
      ),
    )
    .orderBy(desc(salesOffers.version))
    .limit(1);
  return row ?? null;
}

/** Call only while holding the company row lock, shared by publication and individual negotiations. */
export async function nextSalesOfferVersion(db: DbOrTx, companyId: string) {
  const [last] = await db
    .select({ version: salesOffers.version })
    .from(salesOffers)
    .where(eq(salesOffers.companyId, companyId))
    .orderBy(desc(salesOffers.version))
    .limit(1);
  return (last?.version ?? 0) + 1;
}
