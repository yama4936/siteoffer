/**
 * サイト評価スキルの結果（evaluation.json）を、companies・websites・site_audits・findings に取り込む。
 * アプリの評価処理（packages/audit の runSiteAudit）を通さずに採点した結果を、画面で見られるようにするためのもの。
 * pnpm reports:import（scripts/import-reports.ts）と、ワーカーのスキル実行（skills/run.ts）が使う。
 *
 * - 同じ成果物ディレクトリの評価が既にあれば取り込まない（再実行しても増えない）
 * - サイトは正規化URLで照合し、既にあればその企業に紐づける。対象（企業・サイト）を指定した場合はそれに紐づける
 * - 判定は decide.py をアプリと同じ引数で実行して決める（閾値未設定の間は hold）
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AuditOptions,
  type CriticalFlag,
  categoryOf,
  checkEvidence,
  type PythonRunner,
  runDecide,
} from "@siteoffer/audit";
import { type Actor, type Clock, recordEvent } from "@siteoffer/core";
import { companies, type Db, findings, siteAudits, websites } from "@siteoffer/db";
import { normalizeUrl } from "@siteoffer/discovery";
import { moveCompanyStatus } from "../pipeline/status.ts";
import { splitAddress } from "./report-address.ts";

type Json = Record<string, unknown>;

export type EvaluationImportResult =
  | {
      status: "imported" | "dry_run";
      auditId: string | null;
      companyId: string | null;
      evaluation: "evaluated" | "unevaluable";
      totalScore: number | null;
      decision: string;
      companyName: string | null;
    }
  | { status: "already_imported"; auditId: string }
  | { status: "failed"; reason: string };

/** 実行記録の model 欄（「claude-opus-5-5（…注記…）」）からモデルIDだけを取る */
function modelId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^[A-Za-z0-9][A-Za-z0-9._:-]*/);
  return m ? m[0] : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function importEvaluationDir(
  deps: { db: Db; clock: Clock; runner: PythonRunner; options: AuditOptions },
  dir: string,
  opts: { actor: Actor; source: string; dryRun?: boolean; target?: { companyId: string; websiteId: string } },
): Promise<EvaluationImportResult> {
  const { db, clock } = deps;
  const { actor, source } = opts;
  const evaluationPath = path.join(dir, "evaluation.json");
  let ev: Json;
  try {
    ev = JSON.parse(await readFile(evaluationPath, "utf8")) as Json;
  } catch {
    return { status: "failed", reason: "evaluation.json を読めない" };
  }
  const summary = (ev.summary ?? null) as Json | null;
  const status = ev.status === "unevaluable" ? "unevaluable" : "evaluated";
  const targetUrl = str(ev.target_url);
  const norm = targetUrl ? normalizeUrl(targetUrl) : null;
  if (!targetUrl || !norm?.ok) return { status: "failed", reason: "target_url が不正" };
  if (status === "evaluated" && !summary) return { status: "failed", reason: "summary なし。score.py 未実行" };
  const items = status === "evaluated" ? checkEvidence(ev.items) : null;
  if (items && !items.ok) return { status: "failed", reason: `根拠のない項目がある: ${items.message}` };

  const dup = await db.query.siteAudits.findFirst({
    columns: { id: true },
    where: (t, { eq }) => eq(t.artifactDir, dir),
  });
  if (dup) return { status: "already_imported", auditId: dup.id };

  const decided = await runDecide(deps.runner, deps.options, evaluationPath);
  if (!decided.ok) return { status: "failed", reason: decided.message ?? decided.error };

  const company = (ev.company ?? {}) as Json;
  const address = str(company.location);
  const flags = (Array.isArray(ev.critical_flags) ? ev.critical_flags : []) as CriticalFlag[];
  const criticalItems = new Set(flags.map((f) => f.item).filter((i): i is string => typeof i === "string"));
  const totalScore = typeof summary?.total_score === "number" ? summary.total_score : null;
  const base = {
    evaluation: status,
    totalScore,
    decision: decided.value.decision,
    companyName: str(company.name),
  } as const;
  if (opts.dryRun) return { status: "dry_run", auditId: null, companyId: null, ...base };

  return db.transaction(async (tx) => {
    const now = clock.now();
    const site = opts.target
      ? { companyId: opts.target.companyId, id: opts.target.websiteId }
      : await tx.query.websites.findFirst({ where: (t, { eq }) => eq(t.normalizedUrl, norm.value.normalizedUrl) });
    let companyId = site?.companyId;
    let websiteId = site?.id;
    if (companyId && status === "evaluated") {
      // 収集ジョブ（company-discovery スキル等）で入った診断前の企業は、評価の取り込みで診断済みに進める
      await moveCompanyStatus(tx, clock, {
        companyId,
        from: ["collected", "site_confirmed"],
        to: "audited",
        reason: "スキルの評価結果を取り込んだ",
        meta: { source },
      });
    }
    if (!companyId) {
      const [row] = await tx
        .insert(companies)
        .values({
          name: str(company.name) ?? norm.value.domain,
          ...splitAddress(address),
          address,
          industry: str(company.industry_guess),
          // 評価で読んだサイトだが、運営は公式サイトか確認していない。
          // 評価不能はサイトを読めず企業名も公式サイトで確かめていないので、確認待ちにする
          officialSiteStatus: status === "unevaluable" ? "needs_review" : "candidate",
          pipelineStatus: "audited",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: companies.id });
      companyId = row!.id;
      await recordEvent(tx, clock, {
        actor,
        action: "company.imported",
        targetType: "company",
        targetId: companyId,
        after: { source },
      });
    }
    if (!websiteId) {
      const [row] = await tx
        .insert(websites)
        .values({
          companyId,
          url: targetUrl,
          normalizedUrl: norm.value.normalizedUrl,
          domain: norm.value.domain,
          kind: "current",
          isPrimary: true,
        })
        .returning({ id: websites.id });
      websiteId = row!.id;
    }
    const [audit] = await tx
      .insert(siteAudits)
      .values({
        companyId,
        websiteId,
        status,
        targetUrl,
        finalUrl: str(ev.final_url),
        rubricVersion: str(summary?.rubric_version) ?? str(ev.rubric_version),
        totalScore: totalScore === null ? null : String(totalScore),
        coverage: typeof summary?.coverage === "number" ? String(summary.coverage) : null,
        scoreConfirmed: status === "evaluated" ? summary?.score_confirmed === true : false,
        criticalFlags: flags,
        summary,
        decision: decided.value.decision,
        decisionReason: decided.value.reasons.join("。"),
        unevaluableReason: status === "unevaluable" ? (str(ev.fatal_reason) ?? "採点で評価不能と判断された") : null,
        evaluatorModel: modelId((ev.evaluator as Json | undefined)?.model),
        artifactDir: dir,
        attempts: 1,
        fetchedAt: parseDate(ev.collected_at),
        evaluatedAt: parseDate(ev.evaluated_at),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: siteAudits.id });
    if (items?.ok && items.value.length) {
      await tx.insert(findings).values(
        items.value.map((it) => ({
          auditId: audit!.id,
          itemCode: it.id,
          category: categoryOf(it.id),
          status: it.status,
          score: it.status === "scored" ? (it.level ?? null) : null,
          reason: it.reason ?? null,
          observations: it.observations ?? [],
          improvementHint: it.improvement_hint ?? null,
          inference: it.inference === true,
          critical: criticalItems.has(it.id),
        })),
      );
    }
    await recordEvent(tx, clock, {
      actor,
      action: "site_audit.imported",
      targetType: "site_audit",
      targetId: audit!.id,
      after: { source, status, totalScore, decision: decided.value.decision },
    });
    return { status: "imported" as const, auditId: audit!.id, companyId, ...base };
  });
}
