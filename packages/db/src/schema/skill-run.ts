import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./common.ts";
import { companies } from "./companies.ts";
import { siteAudits } from "./site-audit.ts";
import { users } from "./users.ts";

/** 運営画面・定期実行から起動できるスキル（.agents/skills の名前） */
export const SKILL_NAMES = ["company-discovery", "site-evaluation", "site-proposal", "site-rebuild"] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

export const SKILL_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type SkillRunStatus = (typeof SKILL_RUN_STATUSES)[number];

/** 実行結果の要約（画面表示用）。実在企業の本文や秘密値は入れない */
export interface SkillRunResult {
  /** スキルの最終応答の要約（Codexが書いたもの） */
  summary?: string;
  /** スキルの最終応答の状態。completed：成果物を作った／skipped：判定により作らなかった／blocked：材料不足等で止めた */
  outcome?: "completed" | "skipped" | "blocked";
  /** reports/ からの相対パス */
  outputDir?: string;
  /** 取り込み結果 */
  imported?: Record<string, unknown>;
  /** 続けて作った実行 */
  chainedRunIds?: string[];
  /** 評価の成果物ディレクトリへ書き戻したファイル数と、写さなかったもの（リンク等） */
  changedFiles?: number;
  skippedFiles?: string[];
  usage?: Record<string, number> | null;
  threadId?: string | null;
  requestedModel?: string | null;
}

/**
 * スキルの1回の実行。運営の起動・定期実行・前のスキルからの連鎖で作られ、ワーカーが隔離コンテナのCodex SDKで実行する。
 * 対象が企業・評価のスキルは companyId・auditId を持つ。同じ対象の未完了の実行は1件に保つ。
 */
export const skillRuns = pgTable(
  "skill_runs",
  {
    id: id(),
    skill: text("skill", { enum: SKILL_NAMES }).notNull(),
    /** 起動条件（地域・業種・件数、続けて実行するか等）。スキルごとの形は worker の skills/definitions.ts */
    params: jsonb("params").notNull().default({}),
    status: text("status", { enum: SKILL_RUN_STATUSES }).notNull().default("queued"),
    trigger: text("trigger", { enum: ["manual", "schedule", "chain"] }).notNull(),
    companyId: uuid("company_id").references(() => companies.id),
    auditId: uuid("audit_id").references(() => siteAudits.id),
    parentRunId: uuid("parent_run_id"),
    /** 同じ対象の未完了の実行を1件に保つためのキー（スキル名と対象） */
    targetKey: text("target_key").notNull(),
    retryOfRunId: uuid("retry_of_run_id").unique(),
    result: jsonb("result").$type<SkillRunResult>(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("skill_runs_one_open_target").on(t.targetKey).where(sql`${t.status} in ('queued', 'running')`),
    index("skill_runs_status_created").on(t.status, t.createdAt),
  ],
);

/**
 * スキルの定期実行の設定。スキルごとに1件。既定は無効（頻度・件数の上限は未決のため、運営が有効にしたときだけ動く）。
 */
export const skillSchedules = pgTable("skill_schedules", {
  skill: text("skill", { enum: SKILL_NAMES }).primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  /** 実行間隔（時間） */
  intervalHours: integer("interval_hours").notNull(),
  /** 1回に起動する件数・条件 */
  params: jsonb("params").notNull().default({}),
  nextRunAt: ts("next_run_at"),
  lastRunAt: ts("last_run_at"),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
});
