import { releaseExpiredAssignments } from "@siteoffer/core";
import { recoverExpiredGenerationJobs } from "@siteoffer/generation";
import { dispatchAuditRequests, reconcileAuditRequest } from "./audit-request-dispatch.ts";
import type { JobQueue, WorkerDeps } from "./deps.ts";
import { executeStep, type StepExecutionOptions, type StepOutcome } from "./execute.ts";
import { dispatchProposalHandoffs } from "./handoff.ts";
import { auditStep } from "./pipeline/audit.ts";
import { discoveryStep, recoverStaleDiscoveryJobs } from "./pipeline/discovery.ts";
import { proposalStep } from "./pipeline/proposal.ts";
import { recoverPipelineSteps } from "./pipeline-recovery.ts";
import { auditPayloadSchema, discoveryPayloadSchema, proposalPayloadSchema, QUEUES, type QueueName } from "./queues.ts";

export type RunOutcome =
  | StepOutcome<unknown>
  | { status: "invalid_payload"; reason: string }
  | { status: "maintenance"; result: unknown };

/**
 * キュー名と内容を受け取り、対応する処理を実行する。pg-boss からも、テストからも同じ入口で呼ぶ。
 */
export function createWorkerRuntime(deps: WorkerDeps) {
  async function run(name: QueueName, data: unknown, options?: StepExecutionOptions): Promise<RunOutcome> {
    switch (name) {
      case QUEUES.discovery: {
        const p = discoveryPayloadSchema.safeParse(data);
        if (!p.success) return { status: "invalid_payload", reason: p.error.message };
        return executeStep(deps, discoveryStep, p.data);
      }
      case QUEUES.audit: {
        const p = auditPayloadSchema.safeParse(data);
        if (!p.success) return { status: "invalid_payload", reason: p.error.message };
        const outcome = await executeStep(deps, auditStep, p.data, options);
        if (p.data.requestKey.startsWith("ops:"))
          await reconcileAuditRequest(deps.db, deps.clock, p.data.requestKey.slice(4));
        return outcome;
      }
      case QUEUES.proposal: {
        const p = proposalPayloadSchema.safeParse(data);
        if (!p.success) return { status: "invalid_payload", reason: p.error.message };
        return executeStep(deps, proposalStep, p.data, options);
      }
      case QUEUES.expireAssignments: {
        const result = await releaseExpiredAssignments(deps.db, deps.clock);
        if (result.released.length || result.escalated.length) deps.logger.info("担当の期限を処理した", { ...result });
        return { status: "maintenance", result };
      }
      case QUEUES.recoverPipeline: {
        const recovered = await recoverPipelineSteps(deps);
        return { status: "maintenance", result: { recovered } };
      }
      case QUEUES.dispatchHandoffs: {
        const result = await dispatchProposalHandoffs(deps);
        const audits = await dispatchAuditRequests(deps);
        return { status: "maintenance", result: { ...result, audits } };
      }
      case QUEUES.recoverGeneration: {
        const recovered = await recoverExpiredGenerationJobs(deps.db, deps.clock);
        if (recovered.length) deps.logger.warn("接続が途切れた生成履歴を閉じました", { recovered });
        return { status: "maintenance", result: { recovered } };
      }
      case QUEUES.recoverDiscovery: {
        const recovered = await recoverStaleDiscoveryJobs(deps.db, deps.clock, deps.discoveryStaleAfterMs);
        if (recovered.length) deps.logger.warn("実行中のまま残った収集ジョブを失敗に戻した", { recovered });
        return { status: "maintenance", result: { recovered } };
      }
      default: {
        const never: never = name;
        return { status: "invalid_payload", reason: `未知のキュー：${String(never)}` };
      }
    }
  }
  return { run };
}

export type WorkerRuntime = ReturnType<typeof createWorkerRuntime>;

/**
 * メモリ上のキュー（テスト・pg-boss なしでの確認用）。
 * pg-boss の exclusive ポリシーと同じく、同じキュー・同じ singletonKey の未処理ジョブは1件に保つ。
 */
export class InMemoryQueue implements JobQueue {
  readonly sent: { name: QueueName; data: object; singletonKey: string }[] = [];
  private readonly pending: { name: QueueName; data: object; singletonKey: string }[] = [];

  async send(name: QueueName, data: object, options: { singletonKey: string }): Promise<void> {
    const item = { name, data, singletonKey: options.singletonKey };
    this.sent.push(item);
    if (this.pending.some((p) => p.name === name && p.singletonKey === options.singletonKey)) return;
    this.pending.push(item);
  }

  get size(): number {
    return this.pending.length;
  }

  /**
   * 溜まったジョブを順に実行する。retry の結果は再投入する（pg-boss の再試行の模擬）。
   * maxRuns は無限ループの防止。
   */
  async drain(
    runtime: WorkerRuntime,
    options: { maxRuns?: number } = {},
  ): Promise<{ name: QueueName; outcome: RunOutcome }[]> {
    const results: { name: QueueName; outcome: RunOutcome }[] = [];
    const maxRuns = options.maxRuns ?? 100;
    while (this.pending.length > 0) {
      if (results.length >= maxRuns) throw new Error(`drain が ${maxRuns} 回を超えた`);
      const item = this.pending.shift()!;
      const outcome = await runtime.run(item.name, item.data);
      results.push({ name: item.name, outcome });
      if (outcome.status === "retry") this.pending.push(item);
    }
    return results;
  }
}
