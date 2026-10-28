import type { PgBoss } from "pg-boss";
import type { WorkerConfig } from "./config.ts";
import type { JobQueue, Logger } from "./deps.ts";
import { QUEUES, type QueueName, type StepKind } from "./queues.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { SKILL_TIMEOUT_MS } from "./skills/definitions.ts";

/** pg-boss の機能のうち、ここで使うものだけ（テストで差し替えられるようにする） */
export type BossLike = Pick<PgBoss, "createQueue" | "updateQueue" | "work" | "schedule" | "send">;

const STEP_QUEUES: Record<StepKind, QueueName> = {
  discovery: QUEUES.discovery,
  audit: QUEUES.audit,
  proposal: QUEUES.proposal,
};

/**
 * キューの作成・処理関数の登録・定期ジョブの登録。
 * - 処理のキューは exclusive（同じ singletonKey のジョブは待機中・実行中を合わせて1件）。冪等キーを singletonKey にする。
 * - 再試行（retryLimit）と制限時間（expireInSeconds）は、ステップの上限（policies）に合わせる。
 *   試行回数の正は実行台帳（ledger.ts）で、pg-boss の再試行が多く残っていても台帳の上限で止まる。
 * - 処理関数は runtime.run を呼ぶ。retry の結果は例外にして pg-boss に再試行させる。
 */
export async function registerQueues(
  boss: BossLike,
  runtime: WorkerRuntime,
  config: Pick<WorkerConfig, "policies" | "schedules" | "concurrency"> & {
    discoveryOnly?: boolean;
    skillConcurrency?: number;
  },
  logger: Logger,
): Promise<void> {
  for (const [kind, name] of Object.entries(STEP_QUEUES) as [StepKind, QueueName][]) {
    if (config.discoveryOnly && kind !== "discovery") continue;
    const policy = config.policies[kind];
    await boss.createQueue(name, {
      policy: "exclusive",
      retryLimit: Math.max(policy.maxAttempts - 1, 0),
      retryDelay: policy.retryDelaySeconds,
      retryBackoff: true,
      // 処理側の制限時間より少し長くする（処理側で打ち切って失敗を記録するのが先になるように）
      expireInSeconds: Math.ceil(policy.timeoutMs / 1000) + 60,
    });
    const tracked = kind === "audit" || kind === "proposal";
    if (tracked) await boss.updateQueue(name, { heartbeatSeconds: 120 });
    await boss.work(
      name,
      { localConcurrency: config.concurrency[kind], ...(tracked ? { heartbeatRefreshSeconds: 20 } : {}) },
      async (jobs) => {
        for (const job of jobs) {
          const outcome = await runtime.run(
            name,
            job.data,
            tracked ? { queueClaim: { id: job.id, retryCount: job.retryCount }, signal: job.signal } : undefined,
          );
          if (outcome.status === "retry") throw new Error(outcome.reason);
          // 同じキーが別の場所で実行中：少し後にもう一度確かめる（実行中のまま残っていれば台帳が stale として閉じる）
          if (outcome.status === "duplicate" && outcome.state === "running") {
            throw new Error(`同じキーのステップが実行中：${outcome.key}`);
          }
          if (outcome.status === "invalid_payload")
            logger.error("ジョブの内容が不正", { queue: name, reason: outcome.reason });
        }
      },
    );
  }

  if (!config.discoveryOnly) {
    // スキルは実Codexの費用がかかるため pg-boss では再試行しない（失敗は記録し、運営が画面から再実行する）
    await boss.createQueue(QUEUES.skill, {
      policy: "exclusive",
      retryLimit: 0,
      expireInSeconds: Math.ceil(Math.max(...Object.values(SKILL_TIMEOUT_MS)) / 1000) + 300,
    });
    await boss.work(QUEUES.skill, { localConcurrency: config.skillConcurrency ?? 1 }, async (jobs) => {
      for (const job of jobs) {
        const outcome = await runtime.run(QUEUES.skill, job.data, { signal: job.signal });
        if (outcome.status === "invalid_payload")
          logger.error("ジョブの内容が不正", { queue: QUEUES.skill, reason: outcome.reason });
      }
    });
  }

  for (const [name, cron] of [
    [QUEUES.expireAssignments, config.schedules.expireAssignments],
    [QUEUES.recoverDiscovery, config.schedules.recoverDiscovery],
    [QUEUES.recoverGeneration, config.schedules.recoverGeneration],
    [QUEUES.dispatchHandoffs, config.schedules.dispatchHandoffs],
    [QUEUES.recoverPipeline, config.schedules.recoverPipeline],
    [QUEUES.skillSchedules, config.schedules.skillSchedules],
  ] as const) {
    if (
      config.discoveryOnly &&
      (name === QUEUES.dispatchHandoffs || name === QUEUES.recoverPipeline || name === QUEUES.skillSchedules)
    )
      continue;
    await boss.createQueue(name, { policy: "singleton", retryLimit: 2, retryDelay: 60, expireInSeconds: 600 });
    await boss.schedule(name, cron, {}, { tz: "Asia/Tokyo" });
    await boss.work(name, async () => {
      await runtime.run(name, {});
    });
  }
}

export function createBossQueue(boss: Pick<PgBoss, "send">): JobQueue {
  return {
    async send(name, data, options) {
      await boss.send(name, data, { singletonKey: options.singletonKey });
    },
  };
}
