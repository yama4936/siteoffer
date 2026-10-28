/**
 * company-discovery スキルが Web で調べた企業候補（candidates.json）を、収集ジョブとしてDBへ取り込む。
 * 取得元は「agent-web」（エージェントの調査による手動取り込み。自動収集の実装済みとは扱わない、8.3）。
 *
 * - 取り込みは packages/discovery の runDiscovery を通す。法人番号・外部ID・正規化URLでの重複排除、
 *   地域条件と出典付き所在地の照合、営業抑止の維持、公式サイトの確度判定は自動収集と同じ規則になる
 * - 同じ候補ファイルを再実行しても企業は増えない
 * - 診断へは送らない（評価は site-evaluation スキルで行い、pnpm reports:import で取り込む）
 *
 * 実行：
 *   node --env-file-if-exists=.env --import tsx scripts/import-discovery.ts <candidates.json> --check   # DBと reports/ を照合するだけ
 *   node --env-file-if-exists=.env --import tsx scripts/import-discovery.ts <candidates.json>           # 収集ジョブとして取り込む
 *   （--demo でデモDB）
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateDomain,
  findCandidateCompany,
  importCandidates,
  parseCandidatesFile,
} from "../apps/worker/src/skills/discovery-import.ts";
import { DEMO_DATABASE_URL } from "../demo/paths.ts";
import { systemClock } from "../packages/core/src/common/clock.ts";
import { createDb } from "../packages/db/src/index.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const check = args.includes("--check");
const demo = args.includes("--demo");
if (!file) throw new Error("候補ファイル（candidates.json）を指定してください");
const databaseUrl = demo ? DEMO_DATABASE_URL : process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL が設定されていません（デモDBは --demo）");

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const raw: unknown = JSON.parse(await readFile(file, "utf8"));
const parsed = parseCandidatesFile(raw);
if (!parsed.ok) throw new Error(parsed.message ?? parsed.error);

const { db, close } = createDb(databaseUrl);
try {
  if (check) {
    // 取り込み前の照合：DBの既存企業・営業抑止と、reports/sites の評価済みディレクトリ
    for (const c of parsed.value.list) {
      const domain = candidateDomain(c);
      const company = await findCandidateCompany(db, c);
      const report = domain && existsSync(path.join(repoRoot, "reports/sites", domain));
      const state = !company
        ? "new"
        : company.suppression !== "none"
          ? `suppressed(${company.suppression})`
          : `existing(${company.pipelineStatus})`;
      console.log(
        [state, c.name, domain ?? "(公式サイトなし)", report ? "report=あり" : "report=なし", company?.id ?? ""]
          .join("\t")
          .trimEnd(),
      );
    }
  } else {
    const r = await importCandidates(db, systemClock, raw, { kind: "system", job: "import-discovery" });
    if (!r.ok) throw new Error(`${r.error}: ${r.message ?? ""}`);
    const s = r.value;
    console.log(
      `収集ジョブ ${s.jobId}：${s.status} 候補${s.found}件（作成${s.created}・更新${s.updated}・スキップ${s.skipped}・失敗${s.failed}）`,
    );
    for (const f of s.failures) console.log(`  ${f.stage}\t${f.externalId ?? "-"}\t${f.reason}`);
    for (const c of s.companies) {
      console.log(
        [
          c.name,
          c.domain ?? "(公式サイトなし)",
          c.companyId ? `${c.officialSiteStatus}/${c.pipelineStatus}/${c.suppression}` : "未登録",
          c.companyId ?? "",
        ]
          .join("\t")
          .trimEnd(),
      );
    }
    if (s.status === "failed") process.exitCode = 1;
  }
} finally {
  await close();
}
