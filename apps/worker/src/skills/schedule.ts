import { type SkillName, skillSchedules } from "@siteoffer/db";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { WorkerDeps } from "../deps.ts";
import { scheduleParamSchemas } from "./definitions.ts";
import { SKILL_ACTOR } from "./run.ts";
import { createSkillRun } from "./runs.ts";
import { listEvaluationCandidates, listProposalCandidates, listRebuildCandidates } from "./targets.ts";

/**
 * 有効な定期実行のうち、予定時刻を過ぎたものの実行を登録する（定期ジョブから毎分呼ぶ）。
 * 次回の予定を先に進めてから登録するため、同じ回を二重に登録しない。対象がなければ何も登録しない。
 */
export async function dispatchSkillSchedules(deps: Pick<WorkerDeps, "db" | "clock" | "logger">) {
  const now = deps.clock.now();
  const due = await deps.db
    .select()
    .from(skillSchedules)
    .where(and(eq(skillSchedules.enabled, true), isNotNull(skillSchedules.nextRunAt), lte(skillSchedules.nextRunAt, now)));
  const created: { skill: SkillName; runIds: string[] }[] = [];
  for (const schedule of due) {
    // 予定時刻が変わっていなければ次回へ進める（他のワーカーが先に進めたら何もしない）
    const [claimed] = await deps.db
      .update(skillSchedules)
      .set({ nextRunAt: new Date(now.getTime() + schedule.intervalHours * 3_600_000), lastRunAt: now })
      .where(and(eq(skillSchedules.skill, schedule.skill), eq(skillSchedules.nextRunAt, schedule.nextRunAt!)))
      .returning({ skill: skillSchedules.skill });
    if (!claimed) continue;
    const params = scheduleParamSchemas[schedule.skill].safeParse(schedule.params);
    if (!params.success) {
      deps.logger.warn("定期実行の条件が不正なため登録しなかった", { skill: schedule.skill });
      continue;
    }
    const runIds: string[] = [];
    const add = async (target: { companyId?: string; auditId?: string }, runParams: Record<string, unknown>) => {
      const r = await createSkillRun(deps.db, deps.clock, {
        skill: schedule.skill,
        params: runParams,
        trigger: "schedule",
        companyId: target.companyId ?? null,
        auditId: target.auditId ?? null,
        actor: SKILL_ACTOR,
      });
      if (r.ok && r.value.created) runIds.push(r.value.runId);
    };
    const p = params.data as Record<string, unknown> & { limit?: number; chain?: boolean };
    switch (schedule.skill) {
      case "company-discovery":
        await add({}, p);
        break;
      case "site-evaluation":
        for (const c of (await listEvaluationCandidates(deps.db, (p.limit ?? 3) * 3)).filter((c) => !c.busy).slice(0, p.limit))
          await add({ companyId: c.companyId }, { chain: p.chain ?? false });
        break;
      case "site-proposal":
        for (const a of (await listProposalCandidates(deps.db, (p.limit ?? 3) * 3)).filter((a) => !a.busy).slice(0, p.limit))
          await add({ auditId: a.auditId }, { chain: p.chain ?? false });
        break;
      case "site-rebuild":
        for (const a of (await listRebuildCandidates(deps.db, (p.limit ?? 1) * 3)).filter((a) => !a.busy).slice(0, p.limit))
          await add({ auditId: a.auditId }, {});
        break;
    }
    created.push({ skill: schedule.skill, runIds });
  }
  if (created.some((c) => c.runIds.length)) deps.logger.info("定期実行のスキルを登録した", { created });
  return created;
}
