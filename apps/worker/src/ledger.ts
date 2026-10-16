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
  /** 開始済みの最新試行番号（開始イベントの重複は数えない） */
  attempts: number;
  succeeded: boolean;
  /** 再試行しない失敗（上限到達・再試行不能）で終わった */
  gaveUp: boolean;
  /** 最新試行に終了記録がない＝実行中（またはプロセスが落ちて残った） */
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
  // 試行単位で集計する。古い試行の遅い終了や重複イベントで現在の実行状態を変えない。
  const attempts = new Map<
    number,
    { startedAt: Date | null; terminal: { action: string; after: StepEventAfter; createdAt: Date } | null }
  >();
  for (const r of rows) {
    const after = (r.after ?? {}) as StepEventAfter;
    const attempt = after.attempt;
    if (!Number.isSafeInteger(attempt) || attempt! < 1) continue;
    const state = attempts.get(attempt!) ?? { startedAt: null, terminal: null };
    if (r.action === STEP_ACTIONS.started) {
      if (!state.startedAt || r.createdAt < state.startedAt) state.startedAt = r.createdAt;
    } else if (r.action === STEP_ACTIONS.succeeded || r.action === STEP_ACTIONS.failed) {
      // 旧記録に相反する終了がある場合は先の確定を採用。同時刻で判別できない場合は成功と断定しない。
      if (
        !state.terminal ||
        r.createdAt < state.terminal.createdAt ||
        (r.createdAt.getTime() === state.terminal.createdAt.getTime() && r.action === STEP_ACTIONS.failed)
      ) {
        state.terminal = { action: r.action, after, createdAt: r.createdAt };
      }
    }
    attempts.set(attempt!, state);
  }
  const started = [...attempts.entries()].filter(([, s]) => !!s.startedAt).sort(([a], [b]) => a - b);
  const latest = started.at(-1);
  const terminal = latest?.[1].terminal;
  const failure = started.filter(([, s]) => s.terminal?.action === STEP_ACTIONS.failed).at(-1)?.[1].terminal;
  return {
    attempts: latest?.[0] ?? 0,
    succeeded: terminal?.action === STEP_ACTIONS.succeeded,
    gaveUp: terminal?.action === STEP_ACTIONS.failed && terminal.after.final === true,
    running: !!latest && !terminal,
    lastStartedAt: latest?.[1].startedAt ?? null,
    lastFailure: failure?.after.reason ?? null,
  };
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
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:step:${input.key}`}))`);
    const rows = await tx
      .select({ action: auditEvents.action, after: auditEvents.after, createdAt: auditEvents.createdAt })
      .from(auditEvents)
      .where(and(eq(auditEvents.targetType, STEP_TARGET), eq(auditEvents.targetId, input.key)));
    const state = foldStepEvents(rows);
    if (!state.running || state.attempts !== input.attempt) return false;
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
    return true;
  });
}
