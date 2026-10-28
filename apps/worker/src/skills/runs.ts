import { randomUUID } from "node:crypto";
import { type Actor, type Clock, err, ok, type Result, recordEvent } from "@siteoffer/core";
import { type DbOrTx, SKILL_NAMES, type SkillName, skillRuns, skillSchedules } from "@siteoffer/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isAuditOperator } from "../audit-request.ts";
import {
  parseSkillParams,
  SCHEDULE_INTERVAL_HOURS,
  SKILL_TARGET,
  scheduleParamSchemas,
  skillTargetKey,
} from "./definitions.ts";
import { checkSkillTarget } from "./targets.ts";

/**
 * スキル実行の登録（運営の起動・定期実行・連鎖）と、運営の操作（取り消し・再実行・定期実行の設定）。
 * webは skill_runs に行を作るだけで、キューには触れない（ワーカーの受付が拾う）。
 */

export type SkillRunTrigger = "manual" | "schedule" | "chain";

export interface CreateSkillRunInput {
  skill: SkillName;
  params: unknown;
  trigger: SkillRunTrigger;
  companyId?: string | null;
  auditId?: string | null;
  parentRunId?: string | null;
  createdBy?: string | null;
  retryOfRunId?: string | null;
  actor: Actor;
}

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * 実行を登録する。同じ対象の未完了の実行があれば作らずにそのIDを返す（created=false）。
 * 対象の前提条件（営業抑止・評価の有無・既存サイト等）はここで確かめ、実行直前にも確かめ直す。
 */
export async function createSkillRun(
  db: DbOrTx,
  clock: Clock,
  input: CreateSkillRunInput,
): Promise<Result<{ runId: string; created: boolean }, string>> {
  if (!(SKILL_NAMES as readonly string[]).includes(input.skill)) return err("invalid_skill", "スキルが不正です");
  const params = parseSkillParams(input.skill, input.params);
  if (!params.success) return err("invalid_params", `起動条件が不正です：${params.error.issues[0]?.message ?? ""}`);
  const kind = SKILL_TARGET[input.skill];
  const companyId = kind === "company" ? (input.companyId ?? null) : null;
  const auditId = kind === "audit" ? (input.auditId ?? null) : null;
  for (const id of [companyId, auditId]) if (id !== null && !UUID.test(id)) return err("not_found", "対象が見つかりません");
  const target = await checkSkillTarget(db, input.skill, { companyId, auditId });
  if (!target.ok) return err("invalid_target", target.reason);
  const resolvedCompanyId =
    companyId ?? (target.value && "audit" in target.value ? target.value.audit.companyId : null);

  const id = randomUUID();
  const targetKey = skillTargetKey(input.skill, { companyId, auditId, runId: id });
  const [row] = await db
    .insert(skillRuns)
    .values({
      id,
      skill: input.skill,
      params: params.data,
      trigger: input.trigger,
      companyId: resolvedCompanyId,
      auditId,
      parentRunId: input.parentRunId ?? null,
      retryOfRunId: input.retryOfRunId ?? null,
      targetKey,
      createdBy: input.createdBy ?? null,
      createdAt: clock.now(),
    })
    .onConflictDoNothing()
    .returning({ id: skillRuns.id });
  if (!row) {
    const [open] = await db
      .select({ id: skillRuns.id })
      .from(skillRuns)
      .where(and(eq(skillRuns.targetKey, targetKey), inArray(skillRuns.status, ["queued", "running"])))
      .limit(1);
    if (open) return ok({ runId: open.id, created: false });
    return err("conflict", "同じ再実行が登録済みです");
  }
  await recordEvent(db, clock, {
    actor: input.actor,
    action: "skill_run.requested",
    targetType: "skill_run",
    targetId: row.id,
    after: { skill: input.skill, trigger: input.trigger, companyId: resolvedCompanyId, auditId },
  });
  return ok({ runId: row.id, created: true });
}

async function requireOperator(db: DbOrTx, actor: Actor | null): Promise<Result<{ userId: string }, string>> {
  if (actor?.kind !== "ops" || !(await isAuditOperator(db, actor))) return err("forbidden", "運営ユーザーだけが操作できます");
  return ok({ userId: actor.userId });
}

export async function requestSkillRunByOps(
  deps: { db: DbOrTx; clock: Clock },
  actor: Actor | null,
  input: { skill: string; params: unknown; companyId?: string | null; auditId?: string | null },
): Promise<Result<{ runId: string; created: boolean }, string>> {
  const ops = await requireOperator(deps.db, actor);
  if (!ops.ok) return ops;
  if (!(SKILL_NAMES as readonly string[]).includes(input.skill)) return err("invalid_skill", "スキルが不正です");
  return createSkillRun(deps.db, deps.clock, {
    skill: input.skill as SkillName,
    params: input.params,
    trigger: "manual",
    companyId: input.companyId ?? null,
    auditId: input.auditId ?? null,
    createdBy: ops.value.userId,
    actor: actor!,
  });
}

/** 受付待ちの実行だけ取り消せる。実行中のコンテナは止めない（制限時間で止まる） */
export async function cancelSkillRunByOps(
  deps: { db: DbOrTx; clock: Clock },
  actor: Actor | null,
  runId: string,
): Promise<Result<{ runId: string }, string>> {
  const ops = await requireOperator(deps.db, actor);
  if (!ops.ok) return ops;
  if (!UUID.test(runId)) return err("not_found", "実行が見つかりません");
  const [row] = await deps.db
    .update(skillRuns)
    .set({ status: "cancelled", finishedAt: deps.clock.now(), error: "運営が取り消しました" })
    .where(and(eq(skillRuns.id, runId), eq(skillRuns.status, "queued")))
    .returning({ id: skillRuns.id });
  if (!row) return err("invalid_state", "受付待ちの実行だけを取り消せます");
  await recordEvent(deps.db, deps.clock, {
    actor: actor!,
    action: "skill_run.cancelled",
    targetType: "skill_run",
    targetId: runId,
  });
  return ok({ runId });
}

/** 失敗・取り消しの実行を同じ条件でもう一度登録する。同じ実行の再実行は1件だけ */
export async function retrySkillRunByOps(
  deps: { db: DbOrTx; clock: Clock },
  actor: Actor | null,
  runId: string,
): Promise<Result<{ runId: string; created: boolean }, string>> {
  const ops = await requireOperator(deps.db, actor);
  if (!ops.ok) return ops;
  if (!UUID.test(runId)) return err("not_found", "実行が見つかりません");
  const [old] = await deps.db.select().from(skillRuns).where(eq(skillRuns.id, runId)).limit(1);
  if (!old) return err("not_found", "実行が見つかりません");
  if (old.status !== "failed" && old.status !== "cancelled")
    return err("invalid_state", "失敗・取り消しの実行だけを再実行できます");
  const [again] = await deps.db
    .select({ id: skillRuns.id })
    .from(skillRuns)
    .where(eq(skillRuns.retryOfRunId, runId))
    .limit(1);
  if (again) return ok({ runId: again.id, created: false });
  return createSkillRun(deps.db, deps.clock, {
    skill: old.skill,
    params: old.params,
    trigger: "manual",
    companyId: old.companyId,
    auditId: old.auditId,
    retryOfRunId: runId,
    createdBy: ops.value.userId,
    actor: actor!,
  });
}

/**
 * 定期実行の設定を保存する。有効にした時点から間隔をおいて最初の実行をする（保存直後には起動しない）。
 */
export async function saveSkillScheduleByOps(
  deps: { db: DbOrTx; clock: Clock },
  actor: Actor | null,
  input: { skill: string; enabled: boolean; intervalHours: number; params: unknown },
): Promise<Result<{ skill: SkillName }, string>> {
  const ops = await requireOperator(deps.db, actor);
  if (!ops.ok) return ops;
  if (!(SKILL_NAMES as readonly string[]).includes(input.skill)) return err("invalid_skill", "スキルが不正です");
  const skill = input.skill as SkillName;
  const { min, max } = SCHEDULE_INTERVAL_HOURS;
  if (!Number.isInteger(input.intervalHours) || input.intervalHours < min || input.intervalHours > max)
    return err("invalid_interval", `実行間隔は${min}〜${max}時間の整数で指定してください`);
  const params = scheduleParamSchemas[skill].safeParse(input.params ?? {});
  if (!params.success) return err("invalid_params", `条件が不正です：${params.error.issues[0]?.message ?? ""}`);
  const now = deps.clock.now();
  const [before] = await deps.db.select().from(skillSchedules).where(eq(skillSchedules.skill, skill)).limit(1);
  const nextRunAt = input.enabled
    ? before?.enabled && before.nextRunAt && before.intervalHours === input.intervalHours
      ? before.nextRunAt
      : new Date(now.getTime() + input.intervalHours * 3_600_000)
    : null;
  const values = {
    enabled: input.enabled,
    intervalHours: input.intervalHours,
    params: params.data,
    nextRunAt,
    updatedBy: ops.value.userId,
    updatedAt: now,
  };
  await deps.db
    .insert(skillSchedules)
    .values({ skill, ...values })
    .onConflictDoUpdate({ target: skillSchedules.skill, set: values });
  await recordEvent(deps.db, deps.clock, {
    actor: actor!,
    action: "skill_schedule.updated",
    targetType: "skill_schedule",
    targetId: skill,
    before: before ? { enabled: before.enabled, intervalHours: before.intervalHours, params: before.params } : null,
    after: { enabled: input.enabled, intervalHours: input.intervalHours, params: params.data },
  });
  return ok({ skill });
}

/** 実行を終える。実行中（running）のものだけを更新する（取り消し・回復と競合しない） */
export async function finishSkillRun(
  db: DbOrTx,
  clock: Clock,
  runId: string,
  outcome: { status: "succeeded" | "failed"; result?: unknown; error?: string | null },
) {
  const [row] = await db
    .update(skillRuns)
    .set({
      status: outcome.status,
      ...(outcome.result !== undefined ? { result: outcome.result as never } : {}),
      error: outcome.error ? outcome.error.slice(0, 2000) : null,
      finishedAt: clock.now(),
    })
    .where(and(eq(skillRuns.id, runId), eq(skillRuns.status, "running")))
    .returning({ id: skillRuns.id });
  if (row)
    await recordEvent(db, clock, {
      actor: { kind: "system", job: "skill-run" },
      action: `skill_run.${outcome.status}`,
      targetType: "skill_run",
      targetId: runId,
      after: outcome.error ? { error: outcome.error.slice(0, 500) } : null,
    });
  return !!row;
}

/** 受付待ちの実行を実行中にする。他のワーカーが先に取ったら null */
export async function claimSkillRun(db: DbOrTx, clock: Clock, runId: string) {
  const [row] = await db
    .update(skillRuns)
    .set({ status: "running", startedAt: clock.now(), attempts: sql`${skillRuns.attempts} + 1` })
    .where(and(eq(skillRuns.id, runId), eq(skillRuns.status, "queued")))
    .returning();
  return row ?? null;
}
