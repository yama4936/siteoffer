import { type Actor, err, findDomainPreferenceForContract, loadDeliveryInputSource, ok } from "@siteoffer/core";
import {
  contentEntries,
  type DbOrTx,
  deliveries,
  deliveryBuilds,
  deliveryPreparations,
  designVersions,
  imageAssets,
  proposals,
  proposalVersions,
  users,
} from "@siteoffer/db";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
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
  const source = await loadDeliveryInputSource(db, delivery.id);
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
  const [build] = delivery.currentBuildId
    ? await db.select().from(deliveryBuilds).where(eq(deliveryBuilds.id, delivery.currentBuildId))
    : [];
  const needed = source.missing.proposal || source.missing.scope;
  const options = needed
    ? await db
        .select({
          id: proposalVersions.id,
          version: proposalVersions.version,
          designId: designVersions.id,
          designVersion: designVersions.version,
        })
        .from(proposalVersions)
        .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
        .innerJoin(designVersions, sql`${designVersions.id}::text=${proposalVersions.content}->>'designVersionId'`)
        .where(
          and(
            eq(proposals.companyId, company.id),
            eq(designVersions.companyId, company.id),
            eq(proposalVersions.status, "approved"),
            eq(designVersions.status, "approved"),
            isNotNull(designVersions.imageBase64),
            !source.missing.proposal ? eq(proposalVersions.id, contract.proposalVersionId!) : undefined,
          ),
        )
        .orderBy(desc(proposalVersions.version))
        .limit(50)
    : [];
  const history = await db
    .select({
      id: deliveryPreparations.id,
      revision: deliveryPreparations.revision,
      reason: deliveryPreparations.reason,
      scope: deliveryPreparations.scope,
      at: deliveryPreparations.createdAt,
      by: users.displayName,
    })
    .from(deliveryPreparations)
    .innerJoin(users, eq(users.id, deliveryPreparations.confirmedBy))
    .where(eq(deliveryPreparations.deliveryId, delivery.id))
    .orderBy(desc(deliveryPreparations.revision))
    .limit(5);
  return ok({
    deliveryId,
    supplement: source.preparation ? { id: source.preparation.id, revision: source.preparation.revision } : null,
    supplementation: {
      needed,
      missingScope: source.missing.scope,
      editable:
        needed &&
        (delivery.status === "info_gathering" || (delivery.status === "building" && build?.status === "failed")),
      revision: source.preparation?.revision ?? 0,
      proposalVersionId:
        source.preparation?.proposalVersionId ?? (!source.missing.proposal ? contract.proposalVersionId : null),
      scopeText: source.missing.scope && typeof source.preparation?.scope === "string" ? source.preparation.scope : "",
      options,
      history: history.map((h) => ({ ...h, at: h.at.toISOString() })),
    },
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
