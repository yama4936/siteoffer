/**
 * reports の site-proposal / site-rebuild 成果物を、提案版としてDBへ取り込む。
 * 取り込む前にAIの事前チェック（このリポジトリの .agents/skills/site-rebuild/scripts/check.py 等）を行い、
 * 合格は運営の最終確認待ち（in_review）、不合格は failed として保存する。
 * 使い方：scripts/import-skill-proposals.ts [--demo] [--audit-id <id>] [--repo-root <path>]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { importSkillProposalVersion } from "../apps/worker/src/skills/proposal-import.ts";
import { DEMO_DATABASE_URL } from "../demo/paths.ts";
import { systemClock } from "../packages/core/src/common/clock.ts";
import { createDb, siteAudits } from "../packages/db/src/index.ts";

const demo = process.argv.includes("--demo");
const auditArg = process.argv.indexOf("--audit-id");
const auditId = auditArg >= 0 ? process.argv[auditArg + 1] : null;
const rootArg = process.argv.indexOf("--repo-root");
const rootValue = rootArg >= 0 ? process.argv[rootArg + 1] : null;
const databaseUrl = demo ? DEMO_DATABASE_URL : process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL が設定されていません（デモDBは --demo）");
if (auditArg >= 0 && !auditId) throw new Error("--audit-id の値がありません");
if (rootArg >= 0 && !rootValue) throw new Error("--repo-root の値がありません");
const repoRoot = path.resolve(rootValue ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

const { db, close } = createDb(databaseUrl);
const actor = { kind: "system", job: "import-skill-proposals" } as const;
const counts = { created: 0, existing: 0, skipped: 0, precheckFailed: 0 };

try {
  const audits = (await db.select().from(siteAudits)).filter((audit) => !auditId || audit.id === auditId);
  for (const audit of audits) {
    const result = await importSkillProposalVersion(db, systemClock, actor, audit.id, { repoRoot });
    if (!result.ok) {
      if (
        result.error !== "artifact_missing" &&
        result.error !== "proposal_invalid" &&
        result.error !== "audit_not_evaluated"
      ) {
        throw new Error(`${audit.id}: ${result.error}${result.message ? `（${result.message}）` : ""}`);
      }
      counts.skipped++;
      continue;
    }
    const { version, created, aiCheck } = result.value;
    const label = created ? "created" : "existing";
    counts[label]++;
    if (created && version.status === "failed") counts.precheckFailed++;
    const failedItems = aiCheck?.items.filter((i) => !i.ok).map((i) => i.key) ?? [];
    console.log(
      `${label}: audit=${audit.id} proposal_version=v${version.version} status=${version.status}` +
        ` aiCheck=${aiCheck?.status ?? "なし"}${failedItems.length ? `（${failedItems.join(",")}）` : ""}`,
    );
  }
} finally {
  await close();
}

console.log(
  `作成 ${counts.created}件（うち事前チェック不合格 ${counts.precheckFailed}件）、取込済み ${counts.existing}件、対象外 ${counts.skipped}件`,
);
