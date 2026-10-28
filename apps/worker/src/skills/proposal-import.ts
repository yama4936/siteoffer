/** site-proposal / site-rebuild の成果物を、会社別の新しい提案版として取り込む。 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Actor, authorize, type Clock, err, ok, type Result, recordEvent } from "@siteoffer/core";
import { type DbOrTx, proposals, proposalVersions, siteAudits } from "@siteoffer/db";
import { proposalTextSchema } from "@siteoffer/schemas";
import { and, desc, eq } from "drizzle-orm";
import { resolveImprovementSiteDir } from "../sales/improvement-files.ts";

type Json = Record<string, unknown>;

export type ImportSkillProposalError =
  | "forbidden"
  | "audit_not_found"
  | "audit_not_evaluated"
  | "artifact_missing"
  | "proposal_invalid";

export interface ImportedSkillProposal {
  version: typeof proposalVersions.$inferSelect;
  created: boolean;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((v): v is string => v !== null) : [];
}

function proposalTextFromSkill(raw: Json) {
  const summary = (raw.summary ?? {}) as Json;
  const summaryText = [text(summary.headline), text(summary.direction)].filter(Boolean).join("\n");
  const actions = Array.isArray(raw.actions) ? raw.actions : [];
  const measures = actions.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const action = value as Json;
    if (action.scope === "out_of_scope") return [];
    const target = (action.target ?? {}) as Json;
    const change = (action.change ?? {}) as Json;
    const title = text(action.title);
    const current = text(action.current);
    const problem = text(action.problem);
    const improvement = text(change.description);
    const location = text(target.location);
    if (!title || !current || !problem || !improvement || !location) return [];
    const issueIds = strings(action.issue_ids);
    const id = text(action.id);
    const priority =
      action.priority === "high" || action.priority === "medium" || action.priority === "low"
        ? action.priority
        : "medium";
    return [
      {
        title,
        target: { url: text(target.url), location },
        current,
        problem,
        improvement,
        evidenceRefs: issueIds.length ? issueIds : [id ?? title],
        priority,
      },
    ];
  });
  const limitations = [...strings(raw.limitations), ...strings(raw.open_questions).map((v) => `要確認：${v}`)];
  return proposalTextSchema.safeParse({
    summary: summaryText,
    measures,
    strengths: strings(raw.sales_points),
    limitations,
  });
}

/**
 * 評価IDを明示して取り込む。既存の承認済み版は変更せず、同じ成果物の再実行は増やさない。
 * 新しい版は必ず in_review とし、通常の運営レビューを通してから共有する。
 */
export async function importSkillProposalVersion(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  auditId: string,
): Promise<Result<ImportedSkillProposal, ImportSkillProposalError>> {
  const [audit] = await db.select().from(siteAudits).where(eq(siteAudits.id, auditId)).limit(1);
  if (!audit) return err("audit_not_found");
  // 取り込みスクリプト（system）と運営が対象。営業・未ログインは拒否する
  const auth = authorize(actor, "manage", {
    type: "company",
    companyId: audit.companyId,
    sellable: false,
    assignedUserId: null,
  });
  if (!auth.ok || !actor) return err("forbidden");
  if (audit.status !== "evaluated") return err("audit_not_evaluated");

  const siteDir = await resolveImprovementSiteDir(audit.artifactDir);
  if (!siteDir || !audit.artifactDir) return err("artifact_missing");
  let raw: Json;
  try {
    raw = JSON.parse(await readFile(path.join(audit.artifactDir, "proposal.json"), "utf8")) as Json;
  } catch {
    return err("proposal_invalid");
  }
  const parsed = proposalTextFromSkill(raw);
  if (!parsed.success) return err("proposal_invalid");

  return db.transaction(async (tx) => {
    let [proposal] = await tx.select().from(proposals).where(eq(proposals.companyId, audit.companyId)).limit(1);
    if (!proposal) {
      [proposal] = await tx.insert(proposals).values({ companyId: audit.companyId }).returning();
    }
    const [existing] = await tx
      .select()
      .from(proposalVersions)
      .where(
        and(
          eq(proposalVersions.proposalId, proposal!.id),
          eq(proposalVersions.auditId, audit.id),
          eq(proposalVersions.demoArtifactDir, siteDir),
        ),
      )
      .orderBy(desc(proposalVersions.version))
      .limit(1);
    if (existing) return ok({ version: existing, created: false });

    const [latest] = await tx
      .select({ version: proposalVersions.version })
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, proposal!.id))
      .orderBy(desc(proposalVersions.version))
      .limit(1)
      .for("update");
    const now = clock.now();
    const [version] = await tx
      .insert(proposalVersions)
      .values({
        proposalId: proposal!.id,
        version: (latest?.version ?? 0) + 1,
        status: "in_review",
        auditId: audit.id,
        content: {
          schemaVersion: 1,
          idempotencyKey: `site-rebuild:${audit.id}:${siteDir}`,
          auditId: audit.id,
          revision: "site-rebuild",
          proposalText: parsed.data,
          callScript: null,
          faq: null,
          demoSite: null,
          demoCheck: null,
          generationJobIds: {},
          generator: "site-proposal+site-rebuild",
          failure: null,
        },
        demoArtifactDir: siteDir,
        createdAt: now,
      })
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "proposal_version.import_skill_artifact",
      targetType: "proposal_version",
      targetId: version!.id,
      after: {
        companyId: audit.companyId,
        auditId: audit.id,
        version: version!.version,
        status: version!.status,
        source: "site-proposal+site-rebuild",
      },
    });
    return ok({ version: version!, created: true });
  });
}
