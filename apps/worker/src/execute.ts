import type { Actor } from "@siteoffer/core";
import type { WorkerDeps } from "./deps.ts";
import { claimStep, finishStep } from "./ledger.ts";
import type { StepKind } from "./queues.ts";

/** 同じ入力で再試行しても結果が変わらない失敗（入力不正・判定が create でない等）。再試行せずに止める */
export class PermanentError extends Error {
  override name = "PermanentError";
}

/**
 * 入力・前提条件が合わないため実行しなかった（判定が create でない診断で生成を依頼された等）。
 * 再試行せず、企業・提案版の状態も変えない（onGiveUp を呼ばない）。
 */
export class PreconditionError extends PermanentError {
  override name = "PreconditionError";
}

export class StepTimeoutError extends Error {
  override name = "StepTimeoutError";
}

export interface StepContext {
  attempt: number;
  /** 制限時間を過ぎたら中断される。長い処理は区切りごとに確認する */
  signal: AbortSignal;
}

export interface StepDefinition<P, R> {
  queue: string;
  /** 上限値（deps.policies）の種類 */
  kind: StepKind;
  key(payload: P): string;
  run(deps: WorkerDeps, payload: P, ctx: StepContext): Promise<R>;
  /** 上限到達・再試行不能で止まったときの後始末（企業の pipelineStatus を failed にする等） */
  onGiveUp?(deps: WorkerDeps, payload: P, reason: string): Promise<void>;
  /** 成功時に台帳へ残す要約 */
  summarize?(result: R): unknown;
}

export type StepOutcome<R> =
  | { status: "superseded"; key: string; attempt: number }
  | { status: "succeeded"; key: string; attempt: number; result: R }
  /** 同じキーが成功済み・実行中・上限到達済みのため実行しなかった */
  | { status: "duplicate"; key: string; state: "succeeded" | "running" | "gave_up"; attempts: number }
  /** 失敗。まだ再試行できる（pg-boss では例外にして再試行させる） */
  | { status: "retry"; key: string; attempt: number; reason: string }
  /** 失敗。上限到達または再試行不能で止めた */
  | { status: "failed"; key: string; attempt: number; reason: string };

const WORKER_ACTOR: Actor = { kind: "system", job: "worker" };

/**
 * 1つのステップを実行する。キュー（pg-boss）に依存せず、テストから直接呼べる。
 * 冪等キーで二重実行を防ぎ、制限時間で打ち切り、失敗理由と試行回数を台帳に残す。
 */
export async function executeStep<P, R>(
  deps: WorkerDeps,
  def: StepDefinition<P, R>,
  payload: P,
): Promise<StepOutcome<R>> {
  const key = def.key(payload);
  const policy = deps.policies[def.kind];
  const claim = await claimStep(deps.db, deps.clock, {
    key,
    queue: def.queue,
    maxAttempts: policy.maxAttempts,
    staleAfterMs: policy.timeoutMs,
    actor: WORKER_ACTOR,
  });
  if (claim.kind === "duplicate") {
    deps.logger.info("同じキーのステップは実行しない", { queue: def.queue, key, state: claim.state });
    if (claim.closedStale) {
      // 実行中のまま残った最後の試行を閉じた結果、上限に達した場合も後始末を行う
      await def.onGiveUp?.(deps, payload, "stale: 実行中のまま制限時間を過ぎ、試行回数の上限に達した");
    }
    return { status: "duplicate", key, state: claim.state, attempts: claim.attempts };
  }

  const attempt = claim.attempt;
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new StepTimeoutError(`制限時間（${policy.timeoutMs}ms）を過ぎたため打ち切った`));
    }, policy.timeoutMs);
  });

  try {
    const result = await Promise.race([def.run(deps, payload, { attempt, signal: ac.signal }), timeout]);
    const recorded = await finishStep(deps.db, deps.clock, {
      key,
      queue: def.queue,
      attempt,
      actor: WORKER_ACTOR,
      outcome: { ok: true, summary: def.summarize?.(result) },
    });
    if (!recorded) return { status: "superseded", key, attempt };
    return { status: "succeeded", key, attempt, result };
  } catch (e) {
    const error = e as Error;
    const reason = `${error.name === "Error" ? "" : `${error.name}: `}${error.message}`.slice(0, 2000);
    const final = e instanceof PermanentError || attempt >= policy.maxAttempts;
    const recorded = await finishStep(deps.db, deps.clock, {
      key,
      queue: def.queue,
      attempt,
      actor: WORKER_ACTOR,
      outcome: { ok: false, reason, final },
    });
    if (!recorded) return { status: "superseded", key, attempt };
    if (final) {
      deps.logger.warn("ステップを止めた", { queue: def.queue, key, attempt, reason });
      if (!(e instanceof PreconditionError)) await def.onGiveUp?.(deps, payload, reason);
      return { status: "failed", key, attempt, reason };
    }
    deps.logger.warn("ステップが失敗した（再試行する）", { queue: def.queue, key, attempt, reason });
    return { status: "retry", key, attempt, reason };
  } finally {
    clearTimeout(timer);
  }
}
