import { createHash } from "node:crypto";
import type { Actor } from "@siteoffer/core";
import { type DbOrTx, designVersions, proposals, proposalVersions } from "@siteoffer/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { isUuid } from "./form";
import { requireOps } from "./guard";

export type ReviewDesign = {
  id: string;
  version: number;
  width: number;
  height: number;
  imageUrl: string;
  studioHref: string;
};

/** Read the image pinned to this proposal, never the company's newest design. */
async function pinnedDesign(db: DbOrTx, actor: Actor | null, versionId: string) {
  if (!requireOps(actor).ok || !isUuid(versionId)) return null;
  const [proposal] = await db
    .select({ companyId: proposals.companyId, auditId: proposalVersions.auditId, content: proposalVersions.content })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .where(eq(proposalVersions.id, versionId));
  const content = proposal?.content as { designVersionId?: unknown; designSha256?: unknown } | null;
  if (
    !proposal?.auditId ||
    typeof content?.designVersionId !== "string" ||
    !isUuid(content.designVersionId) ||
    typeof content.designSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(content.designSha256)
  )
    return null;
  const [design] = await db
    .select({
      id: designVersions.id,
      version: designVersions.version,
      auditId: designVersions.auditId,
      companyId: designVersions.companyId,
      sha256: designVersions.imageSha256,
      width: designVersions.width,
      height: designVersions.height,
    })
    .from(designVersions)
    .where(
      and(
        eq(designVersions.id, content.designVersionId),
        eq(designVersions.companyId, proposal.companyId),
        eq(designVersions.auditId, proposal.auditId),
        eq(designVersions.status, "approved"),
        eq(designVersions.imageSha256, content.designSha256),
        isNotNull(designVersions.imageBase64),
      ),
    );
  return design ?? null;
}

export async function readReviewDesign(
  db: DbOrTx,
  actor: Actor | null,
  versionId: string,
): Promise<ReviewDesign | null> {
  const design = await pinnedDesign(db, actor, versionId);
  if (!design) return null;
  return {
    id: design.id,
    version: design.version,
    width: design.width ?? 1536,
    height: design.height ?? 1024,
    imageUrl: `/ops/review/design/${versionId}`,
    studioHref: `/ops/designs?${new URLSearchParams({ company: design.companyId, design: design.id, audit: design.auditId })}`,
  };
}

/** Authorize and recheck pins on every request, including historical proposals. */
export async function serveReviewDesignImage(db: DbOrTx, actor: Actor | null, versionId: string): Promise<Response> {
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  };
  if (!requireOps(actor).ok) return new Response("Forbidden", { status: 403, headers });
  const design = await pinnedDesign(db, actor, versionId);
  if (!design) return new Response("Not Found", { status: 404, headers });
  const [image] = await db
    .select({ data: designVersions.imageBase64 })
    .from(designVersions)
    .where(and(eq(designVersions.id, design.id), eq(designVersions.imageSha256, design.sha256!)));
  const png = Buffer.from(image?.data ?? "", "base64");
  if (
    png.length > 12 * 1024 * 1024 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    createHash("sha256").update(png).digest("hex") !== design.sha256
  )
    return new Response("Artifact integrity error", { status: 503, headers });
  return new Response(new Uint8Array(png), { headers: { ...headers, "Content-Type": "image/png" } });
}
