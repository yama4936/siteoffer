import type { Actor } from "@siteoffer/core";
import { type DbOrTx, proposalVersions } from "@siteoffer/db";
import { and, eq } from "drizzle-orm";
import { serveStaticPreview } from "../ops/preview";
import { getCompanyDetail } from "./queries";

export async function serveSalesPreview(db: DbOrTx, actor: Actor | null, companyId: string, rest: string) {
  const missing = () => new Response("Not Found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  if (actor?.kind !== "sales") return new Response("Forbidden", { status: 403 });
  const detail = await getCompanyDetail(db, actor, companyId);
  if (!detail.ok || !detail.value.proposal) return missing();
  const [v] = await db
    .select({ dir: proposalVersions.demoArtifactDir })
    .from(proposalVersions)
    .where(and(eq(proposalVersions.id, detail.value.proposal.versionId), eq(proposalVersions.status, "approved")));
  if (!v?.dir) return missing();
  return serveStaticPreview(v.dir, rest, `/sales/companies/${companyId}/preview`);
}
