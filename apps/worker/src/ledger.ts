import { type Actor, type Clock, recordEvent } from "@siteoffer/core";
import { auditEvents, type Db } from "@siteoffer/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * ワーカーの処理単位（ステップ）の実行台帳。
 *
 * 冪等キーごとに「開始・成功・失敗」を操作履歴（audit_events、targetType = worker_step）へ残し、
 * そこから状態を導く。専用のテーブルを持たない（マイグレーションは統合担当の所有のため。報告に記載）。
 *
 * - 判定と開始の記録は1つのトランザクションで行い、キーのアドバイザリロック（pg_advisory_xact_lock）で直列化する。
 *   実PostgreSQLで2つのワーカーが同じキーを同時に取りに来ても、片方だけが開始できる。
 * - pg-boss の singletonKey（同じキーのジョブを同時に1件まで）と二重に守る。
 */
export const STEP_TARGET = "worker_step";

export const STEP_ACTIONS = {
  started: "worker.step_started",
  succeeded: "worker.step_succeeded",
  failed: "worker.step_failed",
} as const;

export interface StepState {
  /** 開始した回数（＝試行回数） */
  attempts: number;
  succeeded: boolean;
  /** 再試行しない失敗（上限到達・再試行不能）で終わった */
  gaveUp: boolean;
  /** 開始の記録より終了の記録が少ない＝実行中（またはプロセスが落ちて残った） */
  running: boolean;
  /** 最後に開始した時刻 */
  lastStartedAt: Date | null;
  /** 最後の失敗理由 */
  lastFailure: string | null;
}

export type ClaimResult =
  | { kind: "claimed"; attempt: number; recoveredStale: boolean }
  | {
      kind: "duplicate";
      state: "succeeded" | "running" | "gave_up";
      attempts: number;
      /** 実行中のまま残った最後の試行をこの呼び出しで閉じ、その結果上限に達した */
      closedStale?: boolean;
    };

interface StepEventAfter {
  queue?: string;
  attempt?: number;
  reason?: string;
  final?: boolean;
  timeoutMs?: number;
}

export async function readStepState(db: Db, key: string): Promise<StepState> {
  const rows = await db
    .select({ action: auditEvents.action, after: auditEvents.after, createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(and(eq(auditEvents.targetType, STEP_TARGET), eq(auditEvents.targetId, key)));
  return foldStepEvents(rows);
}

export function foldStepEvents(rows: { action: string; after: unknown; createdAt: Date }[]): StepState {
  let started = 0;
  let finished = 0;
  let succeeded = false;
  let gaveUp = false;
  let lastStartedAt: Date | null = null;
  let lastFailure: string | null = null;
  let lastFailureAttempt = -1;
  for (const r of rows) {
    const after = (r.after ?? {}) as StepEventAfter;
    if (r.action === STEP_ACTIONS.started) {
      started++;
      if (!lastStartedAt || r.createdAt >= lastStartedAt) lastStartedAt = r.createdAt;
    } else if (r.action === STEP_ACTIONS.succeeded) {
      finished++;
      succeeded = true;
    } else if (r.action === STEP_ACTIONS.failed) {
      finished++;
      if (after.final) gaveUp = true;
      const a = after.attempt ?? 0;
      if (a >= lastFailureAttempt) {
        lastFailureAttempt = a;
        lastFailure = after.reason ?? null;
      }
    }
  }
  return { attempts: started, succeeded, gaveUp, running: started > finished, lastStartedAt, lastFailure };
}

/**
 * ステップを開始できるか判定し、できるなら開始を記録する。
 * - 成功済み・上限到達済みのキーは開始しない（二重実行の防止）。
 * - 実行中のキーは開始しない。ただし最後の開始から staleAfterMs を過ぎていれば、プロセスが落ちたとみなして
 *   その試行を失敗として閉じてから開始する。
 * - 試行回数が maxAttempts に達していれば、上限到達として閉じる。
 */
export async function claimStep(
  db: Db,
  clock: Clock,
  input: { key: string; queue: string; maxAttempts: number; staleAfterMs: number; actor: Actor },
): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:step:${input.key}`}))`);
    const rows = await tx
      .select({ action: auditEvents.action, after: auditEvents.after, createdAt: auditEvents.createdAt })
      .from(auditEvents)
      .where(and(eq(auditEvents.targetType, STEP_TARGET), eq(auditEvents.targetId, input.key)));
    const state = foldStepEvents(rows);
    if (state.succeeded) return { kind: "duplicate", state: "succeeded", attempts: state.attempts };
    if (state.gaveUp) return { kind: "duplicate", state: "gave_up", attempts: state.attempts };

    let recoveredStale = false;
    if (state.running) {
      const startedAt = state.lastStartedAt?.getTime() ?? 0;
      if (clock.now().getTime() - startedAt < input.staleAfterMs) {
        return { kind: "duplicate", state: "running", attempts: state.attempts };
      }
      // 実行中のまま残った試行（プロセスの停止など）を失敗として閉じる
      const final = state.attempts >= input.maxAttempts;
      await recordEvent(tx, clock, {
        actor: input.actor,
        action: STEP_ACTIONS.failed,
        targetType: STEP_TARGET,
        targetId: input.key,
        after: {
          queue: input.queue,
          attempt: state.attempts,
          reason: "stale: 実行中のまま制限時間を過ぎた（ワーカーの停止などで中断された）",
          final,
        } satisfies StepEventAfter,
      });
      if (final) return { kind: "duplicate", state: "gave_up", attempts: state.attempts, closedStale: true };
      recoveredStale = true;
    } else if (state.attempts >= input.maxAttempts) {
      return { kind: "duplicate", state: "gave_up", attempts: state.attempts };
    }

    const attempt = state.attempts + 1;
    await recordEvent(tx, clock, {
      actor: input.actor,
      action: STEP_ACTIONS.started,
      targetType: STEP_TARGET,
      targetId: input.key,
      after: { queue: input.queue, attempt } satisfies StepEventAfter,
    });
    return { kind: "claimed", attempt, recoveredStale };
  });
}

export async function finishStep(
  db: Db,
  clock: Clock,
  input: {
    key: string;
    queue: string;
    attempt: number;
    actor: Actor;
    outcome: { ok: true; summary?: unknown } | { ok: false; reason: string; final: boolean };
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    if (input.outcome.ok) {
      await recordEvent(tx, clock, {
        actor: input.actor,
        action: STEP_ACTIONS.succeeded,
        targetType: STEP_TARGET,
        targetId: input.key,
        after: { queue: input.queue, attempt: input.attempt, summary: input.outcome.summary ?? null },
      });
    } else {
      await recordEvent(tx, clock, {
        actor: input.actor,
        action: STEP_ACTIONS.failed,
        targetType: STEP_TARGET,
        targetId: input.key,
        after: {
          queue: input.queue,
          attempt: input.attempt,
          reason: input.outcome.reason.slice(0, 2000),
          final: input.outcome.final,
        } satisfies StepEventAfter,
      });
    }
  });
}
