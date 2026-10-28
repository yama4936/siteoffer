/**
 * 運営の最終確認待ち（in_review）の提案版のうち、AIの事前チェックの結果（content.aiCheck）がないものを検査し直す。
 * 書き込むのは content.aiCheck だけで、版・企業の状態は変えない。
 * 使い方：scripts/recheck-proposal-precheck.ts [--demo] [--all] [--limit <n>] [--repo-root <path>]
 *   --all：aiCheck がある in_review の版も検査し直す
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { recheckInReviewProposalVersions } from "../apps/worker/src/skills/precheck-recheck.ts";
import { DEMO_DATABASE_URL } from "../demo/paths.ts";
import { systemClock } from "../packages/core/src/common/clock.ts";
import { createDb } from "../packages/db/src/index.ts";

function arg(name: string) {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} の値がありません`);
  return v;
}

const demo = process.argv.includes("--demo");
const all = process.argv.includes("--all");
const limitArg = arg("--limit");
const limit = limitArg === null ? 100 : Number(limitArg);
if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("--limit は1〜1000の整数");
const repoRoot = path.resolve(arg("--repo-root") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const databaseUrl = demo ? DEMO_DATABASE_URL : process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL が設定されていません（デモDBは --demo）");

const { db, close } = createDb(databaseUrl);
try {
  const result = await recheckInReviewProposalVersions(
    { db, clock: systemClock },
    { repoRoot, all, limit, actor: { kind: "system", job: "recheck-proposal-precheck" } },
  );
  for (const c of result.checked) console.log(`checked: proposal_version=${c.proposalVersionId} aiCheck=${c.status}`);
  for (const s of result.skipped) console.log(`skipped: proposal_version=${s.proposalVersionId} reason=${s.reason}`);
  const failed = result.checked.filter((c) => c.status === "failed").length;
  console.log(`検査 ${result.checked.length}件（うち不合格 ${failed}件）、対象外 ${result.skipped.length}件`);
} finally {
  await close();
}
