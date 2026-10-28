import { existsSync } from "node:fs";
import path from "node:path";
import { companies, type DbOrTx, type SkillName, siteAudits, skillRuns, websites } from "@siteoffer/db";
import { and, asc, desc, eq, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { currentAuditSite } from "../audit-request.ts";
import { PROTECTED } from "../pipeline/status.ts";
import { checkPublicHttpUrl } from "../url.ts";

/**
 * スキルの対象（企業・評価）の前提条件と、運営画面・定期実行で選べる対象の一覧。
 * 起動時（運営の操作・定期実行・連鎖）と実行直前の両方で同じ判定を使う。
 */

type Company = typeof companies.$inferSelect;
type Website = typeof websites.$inferSelect;
type Audit = typeof siteAudits.$inferSelect;

export type CompanyTarget = { company: Company; website: Website };
export type AuditTarget = { audit: Audit; company: Company; website: Website };

export type TargetCheck<T> = { ok: true; value: T } | { ok: false; reason: string };

const fail = (reason: string) => ({ ok: false as const, reason });

/** 評価の対象：営業抑止がなく、公式サイト（確認済み・候補）の公開URLがある企業 */
export async function checkEvaluationTarget(db: DbOrTx, companyId: string): Promise<TargetCheck<CompanyTarget>> {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return fail("企業が見つかりません");
  if (PROTECTED.includes(company.suppression)) return fail("営業抑止中の企業は評価しません");
  if (!["confirmed", "candidate"].includes(company.officialSiteStatus))
    return fail("公式サイトが未確認です。企業情報で公式サイトを確認してください");
  const website = await currentAuditSite(db, company.id);
  if (!website || !checkPublicHttpUrl(website.url).ok) return fail("評価できる公開HTTP/HTTPSのサイトがありません");
  return { ok: true, value: { company, website } };
}

/** 提案書・サイト作成の対象：評価済みで、成果物ディレクトリが残っている評価 */
async function checkAuditBase(db: DbOrTx, auditId: string): Promise<TargetCheck<AuditTarget>> {
  const [audit] = await db.select().from(siteAudits).where(eq(siteAudits.id, auditId)).limit(1);
  if (!audit) return fail("評価が見つかりません");
  if (audit.status !== "evaluated") return fail("評価が完了していません（評価不能・未完了）");
  if (
    !audit.artifactDir ||
    !path.isAbsolute(audit.artifactDir) ||
    !existsSync(path.join(audit.artifactDir, "evaluation.json"))
  )
    return fail("評価の成果物（evaluation.json）が見つかりません");
  const [company] = await db.select().from(companies).where(eq(companies.id, audit.companyId)).limit(1);
  const [website] = await db.select().from(websites).where(eq(websites.id, audit.websiteId)).limit(1);
  if (!company || !website) return fail("評価の企業・サイトが見つかりません");
  if (PROTECTED.includes(company.suppression)) return fail("営業抑止中の企業には提案を作りません");
  return { ok: true, value: { audit, company, website } };
}

export async function checkProposalTarget(db: DbOrTx, auditId: string) {
  return checkAuditBase(db, auditId);
}

export async function checkRebuildTarget(db: DbOrTx, auditId: string): Promise<TargetCheck<AuditTarget>> {
  const base = await checkAuditBase(db, auditId);
  if (!base.ok) return base;
  const dir = base.value.audit.artifactDir!;
  if (!existsSync(path.join(dir, "proposal.json")))
    return fail("改善提案書（proposal.json）がありません。先に提案書を作成してください");
  // 既存の改善後サイトは上書きしない（SKILL.md：上書き前に確認する。契約で選ばれた版のデモを壊さない）
  if (existsSync(path.join(dir, "site")))
    return fail("この評価には改善後サイトが既にあります。作り直すには再評価してください");
  return { ok: true, value: base.value };
}

export async function checkSkillTarget(
  db: DbOrTx,
  skill: SkillName,
  target: { companyId?: string | null; auditId?: string | null },
): Promise<TargetCheck<CompanyTarget | AuditTarget | null>> {
  switch (skill) {
    case "company-discovery":
      return { ok: true, value: null };
    case "site-evaluation":
      return target.companyId ? checkEvaluationTarget(db, target.companyId) : fail("評価する企業を選んでください");
    case "site-proposal":
      return target.auditId ? checkProposalTarget(db, target.auditId) : fail("提案書を作る評価を選んでください");
    case "site-rebuild":
      return target.auditId ? checkRebuildTarget(db, target.auditId) : fail("サイトを作る評価を選んでください");
  }
}

const openRun = (column: typeof skillRuns.companyId | typeof skillRuns.auditId, ref: unknown) =>
  sql`exists (select 1 from ${skillRuns} where ${column} = ${ref} and ${skillRuns.status} in ('queued', 'running'))`;

/** 評価の候補：まだ評価のない企業（収集直後・公式サイト確認済み）を新しい順に */
export async function listEvaluationCandidates(db: DbOrTx, limit: number) {
  return db
    .select({
      companyId: companies.id,
      name: companies.name,
      prefecture: companies.prefecture,
      city: companies.city,
      officialSiteStatus: companies.officialSiteStatus,
      pipelineStatus: companies.pipelineStatus,
      busy: openRun(skillRuns.companyId, companies.id),
    })
    .from(companies)
    .where(
      and(
        eq(companies.suppression, "none"),
        inArray(companies.officialSiteStatus, ["confirmed", "candidate"]),
        inArray(companies.pipelineStatus, ["collected", "site_confirmed"]),
        notExists(db.select({ one: sql`1` }).from(siteAudits).where(eq(siteAudits.companyId, companies.id))),
      ),
    )
    .orderBy(desc(companies.createdAt))
    .limit(limit);
}

type AuditRow = {
  auditId: string;
  companyId: string;
  name: string;
  totalScore: string | null;
  decision: string | null;
  artifactDir: string | null;
  evaluatedAt: Date | null;
  busy: unknown;
};

/** 評価済みで成果物のある評価（企業ごとに最新）を点数の低い順に */
async function latestEvaluatedAudits(db: DbOrTx): Promise<AuditRow[]> {
  const rows = await db
    .selectDistinctOn([siteAudits.companyId], {
      auditId: siteAudits.id,
      companyId: siteAudits.companyId,
      name: companies.name,
      totalScore: siteAudits.totalScore,
      decision: siteAudits.decision,
      artifactDir: siteAudits.artifactDir,
      evaluatedAt: siteAudits.evaluatedAt,
      busy: openRun(skillRuns.auditId, siteAudits.id),
    })
    .from(siteAudits)
    .innerJoin(companies, eq(companies.id, siteAudits.companyId))
    .where(
      and(eq(siteAudits.status, "evaluated"), isNotNull(siteAudits.artifactDir), eq(companies.suppression, "none")),
    )
    .orderBy(siteAudits.companyId, desc(siteAudits.createdAt));
  return rows.sort((a, b) => Number(a.totalScore ?? 101) - Number(b.totalScore ?? 101));
}

const has = (dir: string | null, name: string) => !!dir && existsSync(path.join(dir, name));

/** 提案書の候補：判定が create（閾値未満・致命項目あり）で、提案書がまだない評価 */
export async function listProposalCandidates(db: DbOrTx, limit: number) {
  return (await latestEvaluatedAudits(db))
    .filter((a) => a.decision === "create" && !has(a.artifactDir, "proposal.json"))
    .slice(0, limit);
}

/** サイト作成の候補：提案書があり、改善後サイトがまだない評価 */
export async function listRebuildCandidates(db: DbOrTx, limit: number) {
  return (await latestEvaluatedAudits(db))
    .filter((a) => has(a.artifactDir, "proposal.json") && !has(a.artifactDir, "site"))
    .slice(0, limit);
}

/** 画面の表示用：対象の企業名 */
export async function companyNames(db: DbOrTx, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(inArray(companies.id, ids))
    .orderBy(asc(companies.name));
  return new Map(rows.map((r) => [r.id, r.name]));
}
