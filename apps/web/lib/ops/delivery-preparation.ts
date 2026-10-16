import { type Actor, err, findDomainPreferenceForContract, loadDeliverySource, ok } from "@siteoffer/core";
import { contentEntries, type DbOrTx, deliveries, imageAssets, users } from "@siteoffer/db";
import { and, eq, sql } from "drizzle-orm";
import { isUuid } from "./form";

/** 選んだ納品に必要な情報だけをまとめる。画像本体・契約書・報酬・生成プロンプトは返さない。 */
export async function getDeliveryPreparation(db: DbOrTx, actor: Actor | null, deliveryId: string) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden");
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  if (!user) return err("forbidden");
  if (!isUuid(deliveryId)) return err("not_found");
  const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  if (!delivery) return err("not_found");
  const source = await loadDeliverySource(db, delivery.contractId);
  if (!source) return err("not_found");
  const { company, contract, proposal, audit, design } = source;
  const [domain, assets, articles] = await Promise.all([
    findDomainPreferenceForContract(db, company.id, contract.assignmentId),
    db
      .select({
        total: sql<number>`count(*)::int`,
        production: sql<number>`count(*) filter(where ${imageAssets.allowProduction} and ${imageAssets.rightsStatus}<>'unknown' and ${imageAssets.confirmedBy} is not null and ${imageAssets.confirmedAt} is not null)::int`,
      })
      .from(imageAssets)
      .where(eq(imageAssets.companyId, company.id)),
    db
      .select({
        total: sql<number>`count(*)::int`,
        published: sql<number>`count(*) filter(where ${contentEntries.publishedRevision} is not null)::int`,
      })
      .from(contentEntries)
      .where(eq(contentEntries.companyId, company.id)),
  ]);
  const brief = design?.brief && typeof design.brief === "object" ? (design.brief as Record<string, unknown>) : {};
  return ok({
    deliveryId,
    company: {
      id: company.id,
      name: company.name,
      address: company.address,
      phone: company.representativePhone,
      industry: company.industry,
    },
    contractId: contract.id,
    completedAt: contract.completedAt?.toISOString() ?? null,
    scope: source.scope,
    proposal: proposal ? { id: proposal.id, version: proposal.version } : null,
    audit: audit ? { id: audit.id, evaluatedAt: audit.evaluatedAt?.toISOString() ?? null } : null,
    design: design
      ? {
          id: design.id,
          version: design.version,
          status: design.status,
          hasImage: !!design.imageBase64,
          scope: typeof brief.scope === "string" ? brief.scope : null,
          updatePlan: typeof brief.updatePlan === "string" ? brief.updatePlan : null,
        }
      : null,
    domain: domain
      ? {
          id: domain.id,
          intent: domain.intent,
          currentDomain: domain.currentDomain,
          candidates: domain.newDomainCandidates,
          manager: domain.currentManager,
          usesEmail: domain.usesEmail,
          wish: domain.customerWish,
          confirmed: !domain.needsOpsReview && !!domain.confirmedAt,
        }
      : null,
    assets: assets[0]!,
    articles: articles[0]!,
    blockers: source.blockers,
    notices: source.notices,
  });
}
export type DeliveryPreparationData = Extract<
  Awaited<ReturnType<typeof getDeliveryPreparation>>,
  { ok: true }
>["value"];
