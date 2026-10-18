import { type Actor, type Clock, err, ok } from "@siteoffer/core";
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  assignments,
  auditRequests,
  companies,
  contracts,
  type DbOrTx,
  deliveries,
  designVersions,
  proposalHandoffs,
  proposals,
  proposalVersions,
  salesOffers,
  siteAudits,
  users,
} from "@siteoffer/db";
import { currentAuditSite } from "@siteoffer/worker/audit-request";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { checkPublicHttpUrl } from "../../../worker/src/url.ts";
import { companyJourneyState } from "./company-journey-state";
import { isUuid } from "./form";

/** One current record per stage, read together; no images, prompts, bodies or contract snapshots. */
export async function getCompanyJourney(db: DbOrTx, clock: Clock, actor: Actor | null, companyId: string) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden");
  if (!isUuid(companyId)) return err("not_found");
  return db.transaction(
    async (tx) => {
      const [active] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
      if (!active) return err("forbidden");
      const [company] = await tx
        .select({
          id: companies.id,
          suppression: companies.suppression,
          pipelineStatus: companies.pipelineStatus,
          officialSiteStatus: companies.officialSiteStatus,
        })
        .from(companies)
        .where(eq(companies.id, companyId));
      if (!company) return err("not_found");
      const site = await currentAuditSite(tx, companyId);
      const [audit] = await tx
        .select({ id: siteAudits.id, status: siteAudits.status, decision: siteAudits.decision })
        .from(siteAudits)
        .where(eq(siteAudits.companyId, companyId))
        .orderBy(desc(siteAudits.createdAt), desc(siteAudits.id))
        .limit(1);
      const [request] = await tx
        .select({ status: auditRequests.status })
        .from(auditRequests)
        .where(and(eq(auditRequests.companyId, companyId), isNull(auditRequests.finishedAt)))
        .limit(1);
      const [design] = await tx
        .select({
          id: designVersions.id,
          auditId: designVersions.auditId,
          status: designVersions.status,
          version: designVersions.version,
          hasImage: sql<boolean>`${designVersions.imageSha256} is not null and ${designVersions.imageSha256} <> '' and ${designVersions.imageBase64} is not null and ${designVersions.imageBase64} <> ''`,
          buildRequested: sql<boolean>`${designVersions.buildRequestedAt} is not null`,
        })
        .from(designVersions)
        .where(eq(designVersions.companyId, companyId))
        .orderBy(desc(designVersions.version))
        .limit(1);
      const [proposal] = await tx
        .select({
          id: proposalVersions.id,
          status: proposalVersions.status,
          version: proposalVersions.version,
          auditId: proposalVersions.auditId,
          designId: sql<string | null>`left(${proposalVersions.content}->>'designVersionId',37)`,
          designHash: sql<string | null>`left(${proposalVersions.content}->>'designSha256',65)`,
        })
        .from(proposalVersions)
        .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
        .where(eq(proposals.companyId, companyId))
        .orderBy(desc(proposalVersions.version))
        .limit(1);
      const [proposalImage] =
        proposal?.status === "approved" && proposal.designId
          ? await tx
              .select({ hash: designVersions.imageSha256, auditId: designVersions.auditId })
              .from(designVersions)
              .where(
                and(
                  eq(designVersions.companyId, companyId),
                  sql`${designVersions.id}::text=${proposal.designId}`,
                  eq(designVersions.status, "approved"),
                  sql`${designVersions.imageBase64} is not null and ${designVersions.imageBase64} <> ''`,
                ),
              )
              .limit(1)
          : [];
      const [handoff] = await tx
        .select({ auditId: proposalHandoffs.auditId })
        .from(proposalHandoffs)
        .where(and(eq(proposalHandoffs.companyId, companyId), isNull(proposalHandoffs.sentAt)))
        .orderBy(desc(proposalHandoffs.createdAt), desc(proposalHandoffs.sourceStepKey))
        .limit(1);
      const [offer] = await tx
        .select({ id: salesOffers.id })
        .from(salesOffers)
        .where(and(eq(salesOffers.companyId, companyId), eq(salesOffers.isPublic, true)))
        .orderBy(desc(salesOffers.version))
        .limit(1);
      const [assignment] = await tx
        .select({ id: assignments.id, status: assignments.status, expiresAt: assignments.expiresAt })
        .from(assignments)
        .where(and(eq(assignments.companyId, companyId), inArray(assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES])))
        .limit(1);
      const [contract] = await tx
        .select({ id: contracts.id, status: contracts.status })
        .from(contracts)
        .where(
          and(eq(contracts.companyId, companyId), inArray(contracts.status, ["reported", "under_review", "completed"])),
        )
        .orderBy(desc(contracts.reportedAt), desc(contracts.id))
        .limit(1);
      const [delivery] = contract
        ? await tx
            .select({ id: deliveries.id, status: deliveries.status })
            .from(deliveries)
            .where(eq(deliveries.contractId, contract.id))
            .limit(1)
        : [];
      const now = clock.now();
      const queueSchema = await tx.execute(sql`select to_regclass('pgboss.job') is not null as present`);
      const queue = (queueSchema as { rows: { present: boolean }[] }).rows[0]?.present
        ? await tx.execute(
            sql`select 1 from pgboss.job where name in ('pipeline.audit','pipeline.proposal') and data->>'companyId'=${companyId} and state in ('created','retry','active') limit 1`,
          )
        : null;
      return ok(
        companyJourneyState({
          company,
          siteUsable: !!site && checkPublicHttpUrl(site.url).ok,
          audit: audit ?? null,
          request: request ?? null,
          design: design ?? null,
          proposal: proposal
            ? {
                id: proposal.id,
                status: proposal.status,
                version: proposal.version,
                hasDocument:
                  !!proposalImage?.hash &&
                  proposal.designHash === proposalImage.hash &&
                  proposal.auditId === proposalImage.auditId,
              }
            : null,
          handoff: !!handoff,
          pipelinePending: !!queue && (queue as { rows: unknown[] }).rows.length > 0,
          offer: !!offer,
          assignment: assignment
            ? {
                id: assignment.id,
                status: assignment.status,
                expired: !!assignment.expiresAt && assignment.expiresAt <= now,
              }
            : null,
          contract: contract ?? null,
          delivery: delivery ?? null,
          checkedAt: now.toISOString(),
        }),
      );
    },
    { isolationLevel: "repeatable read" },
  );
}
export type CompanyJourney = Extract<Awaited<ReturnType<typeof getCompanyJourney>>, { ok: true }>["value"];
