import {
  contracts,
  type Db,
  deliveries,
  deliveryBuilds,
  deliveryChanges,
  deliveryVersions,
  generationJobs,
} from "@siteoffer/db";
import { type GenerationInput, SiteGenerationOutputSchema } from "@siteoffer/schemas";
import { and, eq } from "drizzle-orm";
/** 制作回に固定した変更だけを渡す。社内の受付理由・担当者情報は生成入力に含めない。 */
export async function withDeliveryChange(
  db: Db,
  deliveryId: string,
  companyId: string,
  buildId: string,
  input: GenerationInput,
): Promise<{ input: GenerationInput; baseVersion?: number }> {
  const [build] = await db
    .select({ changeId: deliveryBuilds.changeId })
    .from(deliveryBuilds)
    .innerJoin(deliveries, eq(deliveries.id, deliveryBuilds.deliveryId))
    .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
    .where(and(eq(deliveryBuilds.id, buildId), eq(deliveries.id, deliveryId), eq(contracts.companyId, companyId)));
  if (!build) throw Error("delivery change build mismatch");
  if (!build.changeId) return { input };
  const [row] = await db
    .select({ change: deliveryChanges, base: deliveryVersions })
    .from(deliveryChanges)
    .innerJoin(deliveryVersions, eq(deliveryVersions.id, deliveryChanges.fromVersionId))
    .where(
      and(
        eq(deliveryChanges.id, build.changeId),
        eq(deliveryChanges.deliveryId, deliveryId),
        eq(deliveryVersions.deliveryId, deliveryId),
      ),
    );
  if (!row) throw Error("delivery change source missing");
  const extra = [
    {
      id: `operator-change-${row.change.id}`,
      sourceUrl: null,
      fetchedAt: row.change.createdAt.toISOString(),
      content: JSON.stringify({ version: row.base.version, request: row.change.requestedChanges }),
    },
  ];
  let previousAvailable = false;
  if (row.base.generationJobId) {
    const [job] = await db
      .select({ output: generationJobs.output })
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.id, row.base.generationJobId),
          eq(generationJobs.companyId, companyId),
          eq(generationJobs.purpose, "delivery_site"),
          eq(generationJobs.status, "succeeded"),
        ),
      );
    const parsed = SiteGenerationOutputSchema.safeParse(job?.output);
    if (parsed.success) {
      extra.push({
        id: "approved-before-change",
        sourceUrl: null,
        fetchedAt: row.base.createdAt.toISOString(),
        content: JSON.stringify(parsed.data),
      });
      previousAvailable = true;
    }
  }
  return {
    baseVersion: row.base.version,
    input: {
      ...input,
      externalData: [...input.externalData, ...extra],
      context: {
        ...input.context,
        deliveryChange: { id: row.change.id, baseVersion: row.base.version, previousAvailable },
      },
    },
  };
}
