import { type DesignVersion, proposalRevisionFingerprint } from "@siteoffer/core";
import { auditEvents, type Db, proposals, proposalVersions } from "@siteoffer/db";
import { type GenerationInput, generationOutputSchemas } from "@siteoffer/schemas";
import { and, eq } from "drizzle-orm";
import { PermanentError } from "./execute.ts";

/** Read one sealed, operator-requested source; never pick a newer company's note by proximity. */
export async function withProposalRevision(
  db: Db,
  design: DesignVersion,
  input: GenerationInput,
): Promise<GenerationInput> {
  if (!design.requestKey.startsWith("retry-v2:")) return input;
  const match = /^retry-v2:([a-f0-9-]{36}):([a-f0-9-]{36})$/i.exec(design.requestKey);
  if (!match) throw new PermanentError("再制作の元の提案を確認できません");
  const events = await db
    .select({ after: auditEvents.after, at: auditEvents.createdAt })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "design"),
        eq(auditEvents.targetId, design.id),
        eq(auditEvents.action, "design.retry_build"),
        eq(auditEvents.actorKind, "ops"),
      ),
    )
    .limit(2);
  const snapshot = events[0]?.after as {
    originalDesignId?: unknown;
    previousProposalId?: unknown;
    sha256?: unknown;
    previousProposalSha256?: unknown;
    revisionNote?: unknown;
  } | null;
  if (
    events.length !== 1 ||
    !snapshot ||
    snapshot.originalDesignId !== match[1] ||
    snapshot.previousProposalId !== match[2] ||
    snapshot.sha256 !== design.imageSha256 ||
    typeof snapshot.previousProposalSha256 !== "string" ||
    typeof snapshot.revisionNote !== "string" ||
    snapshot.revisionNote.length > 4000
  )
    throw new PermanentError("保存した再制作の条件を確認できません。修正元の版を確認してください");
  const [source] = await db
    .select({ version: proposalVersions })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .where(
      and(
        eq(proposalVersions.id, match[2]!),
        eq(proposals.companyId, design.companyId),
        eq(proposalVersions.auditId, design.auditId),
      ),
    );
  const previous = source?.version;
  const content = previous?.content as Record<string, unknown> | null;
  if (
    !previous ||
    !["failed", "rejected"].includes(previous.status) ||
    !content ||
    snapshot.revisionNote !== (previous.reviewNote ?? "") ||
    content.designVersionId !== match[1] ||
    content.designSha256 !== design.imageSha256 ||
    proposalRevisionFingerprint(previous) !== snapshot.previousProposalSha256
  )
    throw new PermanentError("再制作の元の提案が変更されたか、企業・診断・画像が一致しません");
  const outputs: Record<string, unknown> = {};
  for (const [key, purpose] of [
    ["proposalText", "proposal_text"],
    ["callScript", "call_script"],
    ["faq", "faq"],
    ["demoSite", "demo_site"],
  ] as const) {
    const parsed = generationOutputSchemas[purpose].safeParse(content[key]);
    if (parsed.success) outputs[key] = parsed.data;
  }
  return {
    ...input,
    externalData: [
      ...input.externalData,
      {
        id: "previous-proposal",
        sourceUrl: null,
        fetchedAt: previous.createdAt.toISOString(),
        content: JSON.stringify(outputs),
      },
    ],
    context: {
      ...input.context,
      proposalRevision: {
        sourceVersionId: previous.id,
        sourceVersion: previous.version,
        sourceSha256: snapshot.previousProposalSha256,
        request: snapshot.revisionNote,
        requestedAt: events[0]!.at.toISOString(),
        previousAvailable: Object.keys(outputs).length > 0,
      },
    },
  };
}
