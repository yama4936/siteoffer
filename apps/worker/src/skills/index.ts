/** 運営画面（apps/web）から使うスキル実行の入口。webは skill_runs・skill_schedules に行を作るだけで、キューには触れない */
import { assessWorkerIntake, type Clock } from "@siteoffer/core";
import { type Db, SKILL_NAMES, type SkillName, skillRuns, skillSchedules, workerRuntimes } from "@siteoffer/db";
import { desc, gte } from "drizzle-orm";
import { scheduleParamSchemas } from "./definitions.ts";
import { companyNames, listEvaluationCandidates, listProposalCandidates, listRebuildCandidates } from "./targets.ts";

export { SCHEDULE_INTERVAL_HOURS, SKILL_LABEL, SKILL_TARGET } from "./definitions.ts";
export {
  cancelSkillRunByOps,
  requestSkillRunByOps,
  retrySkillRunByOps,
  saveSkillScheduleByOps,
} from "./runs.ts";

/** スキル実行を受け付けるワーカーが稼働しているか（稼働通知の設定から判定する。実Codexの接続は証明しない） */
export async function skillAvailability(db: Db, clock: Clock) {
  const rows = await db
    .select()
    .from(workerRuntimes)
    .where(gte(workerRuntimes.heartbeatAt, new Date(clock.now().getTime() - 45_000)));
  const live = rows.filter((row) => assessWorkerIntake(row, clock.now()).live);
  const codexReady = live.some((w) => w.capabilities?.skillRunner === "codex");
  const fixtureReady = live.some((w) => w.capabilities?.skillRunner === "fixture");
  const ready = codexReady || fixtureReady;
  return {
    ready,
    reason: codexReady
      ? "稼働中のワーカーが受け付けます（実行は隔離コンテナのCodex SDK）"
      : fixtureReady
        ? "稼働中のワーカーが固定の試験成果物で処理します（Codex・外部APIは実行しません）"
        : !live.length
          ? "ワーカーの稼働を確認できません。登録した実行は、スキル実行を設定したワーカーが起動すると処理されます"
          : "稼働中のワーカーにスキル実行が設定されていません（SITEOFFER_SKILL_RUNNER=codex）。登録した実行は、設定したワーカーが起動するまで受付待ちのまま残ります",
  };
}

/** 運営画面の表示内容：最近の実行、定期実行の設定、起動できる対象 */
export async function readSkillPage(db: Db, clock: Clock) {
  const runs = await db.select().from(skillRuns).orderBy(desc(skillRuns.createdAt)).limit(60);
  const names = await companyNames(db, [...new Set(runs.map((r) => r.companyId).filter((id): id is string => !!id))]);
  const scheduleRows = await db.select().from(skillSchedules);
  const schedules = SKILL_NAMES.map((skill) => {
    const row = scheduleRows.find((r) => r.skill === skill);
    const params = scheduleParamSchemas[skill].safeParse(row?.params ?? {});
    return {
      skill,
      enabled: row?.enabled ?? false,
      intervalHours: row?.intervalHours ?? 24,
      params: (params.success ? params.data : scheduleParamSchemas[skill].parse({})) as Record<string, unknown>,
      nextRunAt: row?.nextRunAt ?? null,
      lastRunAt: row?.lastRunAt ?? null,
    };
  });
  const [evaluation, proposal, rebuild] = await Promise.all([
    listEvaluationCandidates(db, 200),
    listProposalCandidates(db, 200),
    listRebuildCandidates(db, 200),
  ]);
  return {
    availability: await skillAvailability(db, clock),
    runs: runs.map((r) => ({ ...r, companyName: r.companyId ? (names.get(r.companyId) ?? null) : null })),
    schedules,
    candidates: { evaluation, proposal, rebuild },
  };
}

export type SkillPage = Awaited<ReturnType<typeof readSkillPage>>;
export const SKILLS: readonly SkillName[] = SKILL_NAMES;
