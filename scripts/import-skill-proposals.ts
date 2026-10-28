/** reports の site-proposal / site-rebuild 成果物を、運営確認待ちの提案版としてDBへ取り込む。 */

import { importSkillProposalVersion } from "../apps/worker/src/skills/proposal-import.ts";
import { DEMO_DATABASE_URL } from "../demo/paths.ts";
import { systemClock } from "../packages/core/src/common/clock.ts";
import { createDb, siteAudits } from "../packages/db/src/index.ts";

const demo = process.argv.includes("--demo");
const auditArg = process.argv.indexOf("--audit-id");
const auditId = auditArg >= 0 ? process.argv[auditArg + 1] : null;
const databaseUrl = demo ? DEMO_DATABASE_URL : process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL が設定されていません（デモDBは --demo）");
if (auditArg >= 0 && !auditId) throw new Error("--audit-id の値がありません");

const { db, close } = createDb(databaseUrl);
const actor = { kind: "system", job: "import-skill-proposals" } as const;
const counts = { created: 0, existing: 0, skipped: 0 };

try {
  const audits = (await db.select().from(siteAudits)).filter((audit) => !auditId || audit.id === auditId);
  for (const audit of audits) {
    const result = await importSkillProposalVersion(db, systemClock, actor, audit.id);
    if (!result.ok) {
      if (
        result.error !== "artifact_missing" &&
        result.error !== "proposal_invalid" &&
        result.error !== "audit_not_evaluated"
      ) {
        throw new Error(`${audit.id}: ${result.error}`);
      }
      counts.skipped++;
      continue;
    }
    const label = result.value.created ? "created" : "existing";
    counts[label]++;
    console.log(
      `${label}: audit=${audit.id} proposal_version=v${result.value.version.version} status=${result.value.version.status}`,
    );
  }
} finally {
  await close();
}

console.log(`作成 ${counts.created}件、取込済み ${counts.existing}件、対象外 ${counts.skipped}件`);
