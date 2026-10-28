/** site-proposal / site-rebuild の成果物を、会社別の新しい提案版として取り込む。 */
import { constants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { type Actor, authorize, type Clock, err, ok, type Result, recordEvent } from "@siteoffer/core";
import { companies, type DbOrTx, proposals, proposalVersions, siteAudits } from "@siteoffer/db";
import { proposalTextSchema } from "@siteoffer/schemas";
import { and, desc, eq } from "drizzle-orm";
import { moveCompanyStatus } from "../pipeline/status.ts";
import {
  PrecheckUnavailableError,
  type ProposalAiCheck,
  type PythonRunner,
  precheckFailureMessage,
  runProposalPrecheck,
  summarizeAiCheck,
} from "./precheck.ts";

type Json = Record<string, unknown>;

function inside(root: string, target: string) {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * 改善後サイトのルート（<artifactDir>/site の実体）。site が成果物の外を指すリンクでないことと、
 * index.html が通常ファイルであることを確かめる（apps/web/lib/sales/improvement-files.ts の resolveImprovementSiteDir と同じ判定）。
 */
export async function resolveImprovementSiteDir(artifactDir: string | null): Promise<string | null> {
  if (!artifactDir || !path.isAbsolute(artifactDir)) return null;
  try {
    const root = await realpath(artifactDir);
    const site = await realpath(path.join(root, "site"));
    if (!inside(root, site) || !(await stat(site)).isDirectory()) return null;
    const index = await realpath(path.join(site, "index.html"));
    if (!inside(site, index)) return null;
    const handle = await open(index, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return (await handle.stat()).isFile() ? site : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export type ImportSkillProposalError =
  | "forbidden"
  | "audit_not_found"
  | "audit_not_evaluated"
  | "artifact_missing"
  | "proposal_invalid"
  | "precheck_unavailable";

export interface ImportedSkillProposal {
  version: typeof proposalVersions.$inferSelect;
  created: boolean;
  /** この取り込みで行った（既存の版なら保存済みの）AIの事前チェック */
  aiCheck: ProposalAiCheck | null;
}

export interface ImportSkillProposalOptions {
  /** 検査スクリプト（.agents/skills/site-rebuild/scripts）を読むリポジトリのルート */
  repoRoot: string;
  /** テスト用：検査スクリプトの実行を差し替える */
  python?: PythonRunner;
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
 * 取り込む前にAIの事前チェック（precheck.ts）を行う。合格した版は in_review（運営の最終確認待ち）にして企業を
 * audited→in_review へ進め、不合格の版は failed として理由（content.failure）とチェック結果（content.aiCheck）を残す。
 */
export async function importSkillProposalVersion(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  auditId: string,
  options: ImportSkillProposalOptions,
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

  // 取り込み済みの成果物は検査し直さない（同じ版を返す）
  const found = await findImported(db, audit.companyId, audit.id, siteDir);
  if (found) return ok({ version: found, created: false, aiCheck: aiCheckOf(found) });

  const [company] = await db
    .select({ officialSiteStatus: companies.officialSiteStatus, suppression: companies.suppression })
    .from(companies)
    .where(eq(companies.id, audit.companyId))
    .limit(1);
  if (!company) return err("audit_not_found");
  let aiCheck: ProposalAiCheck;
  try {
    aiCheck = await runProposalPrecheck({
      repoRoot: options.repoRoot,
      siteDir,
      company,
      now: clock.now(),
      ...(options.python ? { python: options.python } : {}),
    });
  } catch (e) {
    if (e instanceof PrecheckUnavailableError) return err("precheck_unavailable", e.message);
    throw e;
  }
  const passed = aiCheck.status === "passed";
  const failure = passed ? null : precheckFailureMessage(aiCheck);

  return db.transaction(async (tx) => {
    let [proposal] = await tx.select().from(proposals).where(eq(proposals.companyId, audit.companyId)).limit(1);
    if (!proposal) {
      [proposal] = await tx.insert(proposals).values({ companyId: audit.companyId }).returning();
    }
    const existing = await findImported(tx, audit.companyId, audit.id, siteDir);
    if (existing) return ok({ version: existing, created: false, aiCheck: aiCheckOf(existing) });

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
        status: passed ? "in_review" : "failed",
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
          failure,
          aiCheck,
        },
        demoArtifactDir: siteDir,
        createdAt: now,
      })
      .returning();
    const summary = summarizeAiCheck(aiCheck);
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
        aiCheck: summary,
      },
    });
    if (passed) {
      // 最終確認待ちの版ができたので、企業を運営確認待ちへ進める（評価済みの企業だけ。他の状態は変えない）
      await moveCompanyStatus(tx, clock, {
        companyId: audit.companyId,
        from: ["audited"],
        to: "in_review",
        reason: "ai_precheck_passed",
        meta: { proposalVersionId: version!.id },
      });
    } else {
      await recordEvent(tx, clock, {
        actor,
        action: "proposal_version.ai_precheck_failed",
        targetType: "proposal_version",
        targetId: version!.id,
        after: { companyId: audit.companyId, auditId: audit.id, failure, aiCheck: summary },
      });
    }
    return ok({ version: version!, created: true, aiCheck });
  });
}

function aiCheckOf(version: typeof proposalVersions.$inferSelect): ProposalAiCheck | null {
  const content = version.content as Json | null;
  return (content?.aiCheck as ProposalAiCheck | undefined) ?? null;
}

async function findImported(db: DbOrTx, companyId: string, auditId: string, siteDir: string) {
  const [row] = await db
    .select({ version: proposalVersions })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .where(
      and(
        eq(proposals.companyId, companyId),
        eq(proposalVersions.auditId, auditId),
        eq(proposalVersions.demoArtifactDir, siteDir),
      ),
    )
    .orderBy(desc(proposalVersions.version))
    .limit(1);
  return row?.version ?? null;
}
