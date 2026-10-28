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
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importEvaluationDir } from "../apps/worker/src/skills/evaluation-import.ts";
import { createPythonRunner, defaultAuditOptions } from "../packages/audit/src/index.ts";
import { systemClock } from "../packages/core/src/common/clock.ts";
import { createDb } from "../packages/db/src/client.ts";

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
    const r = await importEvaluationDir({ db, clock: systemClock, runner, options }, dir, {
      actor,
      source: rel,
      dryRun,
    });
    if (r.status === "failed") {
      console.log(`failed（${r.reason}）: ${rel}`);
      counts.failed++;
    } else if (r.status === "already_imported") {
      counts.alreadyImported++;
    } else {
      console.log(
        `${dryRun ? "dry-run" : "import"}: ${rel} ${r.evaluation} ${r.totalScore ?? "-"}点 判定=${r.decision} ${r.companyName ?? "(企業名なし)"}`,
      );
      if (r.status === "imported") counts.imported++;
    }
  }
} finally {
  await close();
}
console.log(
  `取り込み ${counts.imported}件、取り込み済み ${counts.alreadyImported}件、採点未完了 ${counts.noEvaluation}件、失敗 ${counts.failed}件${dryRun ? "（dry-run）" : ""}`,
);
if (counts.failed) process.exitCode = 1;
