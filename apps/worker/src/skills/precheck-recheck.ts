/**
 * 運営の最終確認待ち（in_review）の版のうち、AIの事前チェックの結果（content.aiCheck）がないものを検査し直す。
 * 書き込むのは content.aiCheck だけで、版・企業の状態は変えない（不合格でも運営が最終確認で差し戻す）。
 */
import { type Actor, type Clock, recordEvent } from "@siteoffer/core";
import { companies, type DbOrTx, proposals, proposalVersions, siteAudits } from "@siteoffer/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { type PythonRunner, runProposalPrecheck, summarizeAiCheck } from "./precheck.ts";
import { resolveImprovementSiteDir } from "./proposal-import.ts";

export interface RecheckOptions {
  repoRoot: string;
  /** true なら aiCheck がある in_review の版も検査し直す */
  all?: boolean;
  limit?: number;
  actor?: Actor;
  python?: PythonRunner;
}

export interface RecheckResult {
  checked: { proposalVersionId: string; status: "passed" | "failed" }[];
  /** 検査できなかった版（site-rebuild の成果物でない、サイトがない、検査中に状態が変わった） */
  skipped: { proposalVersionId: string; reason: "not_site_rebuild" | "site_missing" | "state_changed" }[];
}

const RECHECK_ACTOR: Actor = { kind: "system", job: "proposal-precheck" };

/** 検査スクリプトを動かせないとき（PrecheckUnavailableError）は途中で止めて投げる */
export async function recheckInReviewProposalVersions(
  deps: { db: DbOrTx; clock: Clock },
  options: RecheckOptions,
): Promise<RecheckResult> {
  const missing = sql`${proposalVersions.content} -> 'aiCheck' is null`;
  const rows = await deps.db
    .select({
      id: proposalVersions.id,
      demoArtifactDir: proposalVersions.demoArtifactDir,
      artifactDir: siteAudits.artifactDir,
      companyId: companies.id,
      officialSiteStatus: companies.officialSiteStatus,
      suppression: companies.suppression,
      content: proposalVersions.content,
    })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .innerJoin(companies, eq(companies.id, proposals.companyId))
    .leftJoin(siteAudits, eq(siteAudits.id, proposalVersions.auditId))
    .where(and(eq(proposalVersions.status, "in_review"), options.all ? undefined : missing))
    .orderBy(asc(proposalVersions.createdAt))
    .limit(options.limit ?? 100);

  const result: RecheckResult = { checked: [], skipped: [] };
  for (const row of rows) {
    const content = row.content as Record<string, unknown> | null;
    if (content?.revision !== "site-rebuild") {
      result.skipped.push({ proposalVersionId: row.id, reason: "not_site_rebuild" });
      continue;
    }
    const siteDir = await resolveImprovementSiteDir(row.artifactDir ?? null);
    if (!siteDir || siteDir !== row.demoArtifactDir) {
      result.skipped.push({ proposalVersionId: row.id, reason: "site_missing" });
      continue;
    }
    const aiCheck = await runProposalPrecheck({
      repoRoot: options.repoRoot,
      siteDir,
      company: { officialSiteStatus: row.officialSiteStatus, suppression: row.suppression },
      now: deps.clock.now(),
      ...(options.python ? { python: options.python } : {}),
    });
    const [updated] = await deps.db
      .update(proposalVersions)
      .set({
        content: sql`jsonb_set(coalesce(${proposalVersions.content}, '{}'::jsonb), '{aiCheck}', ${JSON.stringify(aiCheck)}::jsonb)`,
      })
      .where(
        and(
          eq(proposalVersions.id, row.id),
          eq(proposalVersions.status, "in_review"),
          options.all ? undefined : missing,
        ),
      )
      .returning({ id: proposalVersions.id });
    if (!updated) {
      result.skipped.push({ proposalVersionId: row.id, reason: "state_changed" });
      continue;
    }
    await recordEvent(deps.db, deps.clock, {
      actor: options.actor ?? RECHECK_ACTOR,
      action: "proposal_version.ai_precheck_rechecked",
      targetType: "proposal_version",
      targetId: row.id,
      after: { companyId: row.companyId, aiCheck: summarizeAiCheck(aiCheck) },
    });
    result.checked.push({ proposalVersionId: row.id, status: aiCheck.status });
  }
  return result;
}
