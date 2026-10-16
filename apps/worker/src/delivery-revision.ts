import { approvals, contracts, type Db, deliveries, deliveryVersions, generationJobs } from "@siteoffer/db";
import { type GenerationInput, SiteGenerationOutputSchema } from "@siteoffer/schemas";
import { and, desc, eq } from "drizzle-orm";
/** 顧客の依頼と直前の構成を当該納品だけから読み、事実・権限を昇格させずに生成へ渡す。 */
export async function withDeliveryRevision(
  db: Db,
  deliveryId: string,
  companyId: string,
  input: GenerationInput,
): Promise<GenerationInput> {
  const [request] = await db
    .select({
      id: approvals.id,
      comment: approvals.comment,
      at: approvals.decidedAt,
      versionId: deliveryVersions.id,
      version: deliveryVersions.version,
    })
    .from(approvals)
    .innerJoin(deliveryVersions, eq(deliveryVersions.id, approvals.deliveryVersionId))
    .innerJoin(deliveries, eq(deliveries.id, deliveryVersions.deliveryId))
    .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
    .where(
      and(
        eq(deliveryVersions.deliveryId, deliveryId),
        eq(contracts.companyId, companyId),
        eq(approvals.decision, "changes_requested"),
      ),
    )
    .orderBy(desc(deliveryVersions.version), desc(approvals.decidedAt))
    .limit(1);
  if (!request) return input;
  const [base] = await db
    .select()
    .from(deliveryVersions)
    .where(eq(deliveryVersions.deliveryId, deliveryId))
    .orderBy(desc(deliveryVersions.version))
    .limit(1);
  const extra = [
    {
      id: `customer-revision-${request.id}`,
      sourceUrl: null,
      fetchedAt: request.at.toISOString(),
      content: JSON.stringify({ version: request.version, request: request.comment ?? "" }),
    },
  ];
  let previousAvailable = false;
  if (base?.generationJobId) {
    const [job] = await db
      .select({ output: generationJobs.output })
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.id, base.generationJobId),
          eq(generationJobs.companyId, companyId),
          eq(generationJobs.purpose, "delivery_site"),
        ),
      );
    const parsed = SiteGenerationOutputSchema.safeParse(job?.output);
    if (parsed.success) {
      extra.push({
        id: "previous-delivery-site",
        sourceUrl: null,
        fetchedAt: base.createdAt.toISOString(),
        content: JSON.stringify(parsed.data),
      });
      previousAvailable = true;
    }
  }
  return {
    ...input,
    externalData: [...input.externalData, ...extra],
    context: {
      ...input.context,
      deliveryRevision: {
        requestId: request.id,
        requestedVersion: request.version,
        baseVersion: base?.version ?? null,
        previousAvailable,
      },
    },
  };
}
