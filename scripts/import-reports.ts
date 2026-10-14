/**
 * reports/sites/ にあるサイト評価スキルの結果（evaluation.json）を、ローカルDBの
 * companies・websites・site_audits・findings に取り込む。
 * アプリの評価処理（packages/audit の runSiteAudit）を通さずに採点した結果を、画面で見られるようにするためのもの。
 *
 * - 同じ成果物ディレクトリの評価が既にあれば取り込まない（再実行しても増えない）
 * - サイトは正規化URLで照合し、既にあればその企業に紐づける
 * - 判定は decide.py をアプリと同じ引数で実行して決める（閾値未設定の間は hold）
 * - evaluation.json が無い（採点が終わっていない）ディレクトリは飛ばす
 *
 * 実行：pnpm reports:import（--dry-run で書き込まずに内容だけ表示）
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CriticalFlag,
  categoryOf,
  checkEvidence,
  createPythonRunner,
  defaultAuditOptions,
  runDecide,
} from "../packages/audit/src/index.ts";
import { systemClock } from "../packages/core/src/common/clock.ts";
import { recordEvent } from "../packages/core/src/common/events.ts";
import { createDb } from "../packages/db/src/client.ts";
import { companies, findings, siteAudits, websites } from "../packages/db/src/index.ts";
import { normalizeUrl } from "../packages/discovery/src/url.ts";
import { splitAddress } from "./report-address.ts";

type Json = Record<string, unknown>;

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const sitesDir = path.join(repoRoot, "reports/sites");
const dryRun = process.argv.includes("--dry-run");
const actor = { kind: "system", job: "import-reports" } as const;

/** 1サイトにつき最新の日付ディレクトリだけを取り込む */
async function findReportDirs(): Promise<{ dir: string; skipped: string[] }[]> {
  const out: { dir: string; skipped: string[] }[] = [];
  for (const domain of (await readdir(sitesDir)).sort()) {
    const dates = (await readdir(path.join(sitesDir, domain))).sort().reverse();
    const skipped: string[] = [];
    let found = "";
    for (const date of dates) {
      const dir = path.join(sitesDir, domain, date);
      if (existsSync(path.join(dir, "evaluation.json"))) {
        found = dir;
        break;
      }
      skipped.push(path.relative(repoRoot, dir));
    }
    out.push({ dir: found, skipped });
  }
  return out;
}

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

const options = defaultAuditOptions();
const runner = createPythonRunner(options.pythonBin);
const reports = await findReportDirs();
const counts = { imported: 0, alreadyImported: 0, noEvaluation: 0, failed: 0 };

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL が設定されていません");
const { db, close } = createDb(process.env.DATABASE_URL);
try {
  for (const { dir, skipped } of reports) {
    for (const s of skipped) console.log(`skip（evaluation.json なし）: ${s}`);
    if (!dir) {
      counts.noEvaluation++;
      continue;
    }
    const rel = path.relative(repoRoot, dir);
    const evaluationPath = path.join(dir, "evaluation.json");
    const ev = JSON.parse(await readFile(evaluationPath, "utf8")) as Json;
    const summary = (ev.summary ?? null) as Json | null;
    const status = ev.status === "unevaluable" ? "unevaluable" : "evaluated";
    const targetUrl = str(ev.target_url);
    const norm = targetUrl ? normalizeUrl(targetUrl) : null;
    if (!targetUrl || !norm?.ok) {
      console.log(`failed（target_url が不正）: ${rel}`);
      counts.failed++;
      continue;
    }
    if (status === "evaluated" && !summary) {
      console.log(`failed（summary なし。score.py 未実行）: ${rel}`);
      counts.failed++;
      continue;
    }
    const items = status === "evaluated" ? checkEvidence(ev.items) : null;
    if (items && !items.ok) {
      console.log(`failed（根拠のない項目がある: ${items.message}）: ${rel}`);
      counts.failed++;
      continue;
    }

    const dup = await db.query.siteAudits.findFirst({
      columns: { id: true },
      where: (t, { eq }) => eq(t.artifactDir, dir),
    });
    if (dup) {
      counts.alreadyImported++;
      continue;
    }

    const decided = await runDecide(runner, options, evaluationPath);
    if (!decided.ok) {
      console.log(`failed（${decided.message ?? decided.error}）: ${rel}`);
      counts.failed++;
      continue;
    }

    const company = (ev.company ?? {}) as Json;
    const address = str(company.location);
    const flags = (Array.isArray(ev.critical_flags) ? ev.critical_flags : []) as CriticalFlag[];
    const criticalItems = new Set(flags.map((f) => f.item).filter((i): i is string => typeof i === "string"));
    const totalScore = summary?.total_score;
    console.log(
      `${dryRun ? "dry-run" : "import"}: ${rel} ${status} ${totalScore ?? "-"}点 判定=${decided.value.decision} ${str(company.name) ?? "(企業名なし)"}`,
    );
    if (dryRun) continue;

    await db.transaction(async (tx) => {
      const now = systemClock.now();
      const site = await tx.query.websites.findFirst({
        where: (t, { eq }) => eq(t.normalizedUrl, norm.value.normalizedUrl),
      });
      let companyId = site?.companyId;
      let websiteId = site?.id;
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
        await recordEvent(tx, systemClock, {
          actor,
          action: "company.imported",
          targetType: "company",
          targetId: companyId,
          after: { source: rel },
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
          totalScore: typeof totalScore === "number" ? String(totalScore) : null,
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
      await recordEvent(tx, systemClock, {
        actor,
        action: "site_audit.imported",
        targetType: "site_audit",
        targetId: audit!.id,
        after: { source: rel, status, totalScore: totalScore ?? null, decision: decided.value.decision },
      });
    });
    counts.imported++;
  }
} finally {
  await close();
}
console.log(
  `取り込み ${counts.imported}件、取り込み済み ${counts.alreadyImported}件、採点未完了 ${counts.noEvaluation}件、失敗 ${counts.failed}件${dryRun ? "（dry-run）" : ""}`,
);
if (counts.failed) process.exitCode = 1;
