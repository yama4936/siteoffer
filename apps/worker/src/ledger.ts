import { type Actor, type Clock, recordEvent } from "@siteoffer/core";
import { auditEvents, type Db, type DbOrTx } from "@siteoffer/db";
import { and, eq, sql } from "drizzle-orm";
import { lockQueueClaim, parseQueueClaim, type QueueClaim } from "./queue-claim.ts";

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
  | { kind: "superseded" }
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
  queueClaim?: QueueClaim;
  payload?: unknown;
}

export async function readStepExecution(db: DbOrTx, key: string, attempt: number) {
  const [row] = await db
    .select({ after: auditEvents.after })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, STEP_TARGET),
        eq(auditEvents.targetId, key),
        eq(auditEvents.action, STEP_ACTIONS.started),
        sql`${auditEvents.after}->>'attempt' = ${String(attempt)}`,
      ),
    )
    .limit(1);
  return (row?.after ?? {}) as StepEventAfter;
}

export async function readStepState(db: DbOrTx, key: string): Promise<StepState> {
  const rows = await db
    .select({ action: auditEvents.action, after: auditEvents.after, createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(and(eq(auditEvents.targetType, STEP_TARGET), eq(auditEvents.targetId, key)));
  return foldStepEvents(rows);
}

export class StepOwnershipLost extends Error {
  override name = "StepOwnershipLost";
  constructor() {
    super("処理の実行権限が失われたため、古い試行の結果を保存しませんでした");
  }
}

/** 現在の試行であることの照合と業務更新を、再試行の開始と同じロックで確定する。 */
export async function runOwnedStep<T>(
  db: Db,
  key: string,
  attempt: number,
  signal: AbortSignal,
  write: (tx: DbOrTx) => Promise<T>,
  binding?: { queue: string; claim: QueueClaim },
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:step:${key}`}))`);
    const current = await readStepState(tx, key);
    if (signal.aborted || !current.running || current.attempts !== attempt) throw new StepOwnershipLost();
    if (binding && !(await lockQueueClaim(tx, binding.queue, binding.claim))?.owned) throw new StepOwnershipLost();
    const result = await write(tx);
    if (signal.aborted) throw new StepOwnershipLost();
    if (binding && !(await lockQueueClaim(tx, binding.queue, binding.claim))?.owned) throw new StepOwnershipLost();
    return result;
  });
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
  input: {
    key: string;
    queue: string;
    maxAttempts: number;
    staleAfterMs: number;
    actor: Actor;
    queueClaim?: QueueClaim;
    payload?: unknown;
    /** 上限に達した古い試行の後始末。外部処理をせず、渡されたtxだけで更新する。 */
    onFinalFailure?: (tx: DbOrTx, reason: string) => Promise<void>;
  },
): Promise<ClaimResult> {
  return db
    .transaction(async (tx): Promise<ClaimResult> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:step:${input.key}`}))`);
      if (input.queueClaim && !(await lockQueueClaim(tx, input.queue, input.queueClaim))?.owned)
        return { kind: "superseded" };
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
        const previous = rows.find(
          (r) => r.action === STEP_ACTIONS.started && (r.after as StepEventAfter)?.attempt === state.attempts,
        );
        const oldClaim = parseQueueClaim((previous?.after as StepEventAfter)?.queueClaim);
        const takeover =
          oldClaim &&
          input.queueClaim &&
          oldClaim.id === input.queueClaim.id &&
          oldClaim.retryCount < input.queueClaim.retryCount;
        if (!takeover && clock.now().getTime() - startedAt < input.staleAfterMs) {
          return { kind: "duplicate", state: "running", attempts: state.attempts };
        }
        // 実行中のまま残った試行（プロセスの停止など）を失敗として閉じる
        const final = state.attempts >= input.maxAttempts;
        const reason = takeover
          ? "interrupted: キューが停止した試行を回復し、再試行を開始した"
          : "stale: 実行中のまま制限時間を過ぎた（ワーカーの停止などで中断された）";
        if (final) await input.onFinalFailure?.(tx, reason);
        if (input.queueClaim && !(await lockQueueClaim(tx, input.queue, input.queueClaim))?.owned)
          throw new StepOwnershipLost();
        await recordEvent(tx, clock, {
          actor: input.actor,
          action: STEP_ACTIONS.failed,
          targetType: STEP_TARGET,
          targetId: input.key,
          after: {
            queue: input.queue,
            attempt: state.attempts,
            reason,
            final,
          } satisfies StepEventAfter,
        });
        if (input.queueClaim && !(await lockQueueClaim(tx, input.queue, input.queueClaim))?.owned)
          throw new StepOwnershipLost();
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
        after: {
          queue: input.queue,
          attempt,
          ...(input.queueClaim ? { queueClaim: input.queueClaim, payload: input.payload } : {}),
        } satisfies StepEventAfter,
      });
      if (input.queueClaim && !(await lockQueueClaim(tx, input.queue, input.queueClaim))?.owned)
        throw new StepOwnershipLost();
      return { kind: "claimed", attempt, recoveredStale };
    })
    .catch((error: unknown): ClaimResult => {
      if (error instanceof StepOwnershipLost) return { kind: "superseded" };
      throw error;
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
    queueClaim?: QueueClaim;
    outcome: { ok: true; summary?: unknown } | { ok: false; reason: string; final: boolean };
    /** 最終失敗の後始末を終了記録と一緒に確定する。外部処理は禁止。 */
    onFinalFailure?: (tx: DbOrTx, reason: string) => Promise<void>;
  },
): Promise<boolean> {
  return db
    .transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:step:${input.key}`}))`);
      const rows = await tx
        .select({ action: auditEvents.action, after: auditEvents.after, createdAt: auditEvents.createdAt })
        .from(auditEvents)
        .where(and(eq(auditEvents.targetType, STEP_TARGET), eq(auditEvents.targetId, input.key)));
      const state = foldStepEvents(rows);
      if (!state.running || state.attempts !== input.attempt) return false;
      if (input.queueClaim && !(await lockQueueClaim(tx, input.queue, input.queueClaim))?.owned) return false;
      if (input.outcome.ok) {
        await recordEvent(tx, clock, {
          actor: input.actor,
          action: STEP_ACTIONS.succeeded,
          targetType: STEP_TARGET,
          targetId: input.key,
          after: { queue: input.queue, attempt: input.attempt, summary: input.outcome.summary ?? null },
        });
      } else {
        if (input.outcome.final) await input.onFinalFailure?.(tx, input.outcome.reason);
        if (input.queueClaim && !(await lockQueueClaim(tx, input.queue, input.queueClaim))?.owned)
          throw new StepOwnershipLost();
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
      if (input.queueClaim && !(await lockQueueClaim(tx, input.queue, input.queueClaim))?.owned)
        throw new StepOwnershipLost();
      return true;
    })
    .catch((error: unknown) => {
      if (error instanceof StepOwnershipLost) return false;
      throw error;
    });
}
