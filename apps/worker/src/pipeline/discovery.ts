import { type Actor, type Clock, err, ok, type Result, recordEvent } from "@siteoffer/core";
import { companies, type Db, type DbOrTx, discoveryJobs, discoverySources } from "@siteoffer/db";
import { runDiscovery } from "@siteoffer/discovery";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { WorkerDeps } from "../deps.ts";
import { PermanentError, PreconditionError, type StepDefinition } from "../execute.ts";
import { type AuditPayload, type DiscoveryPayload, QUEUES, stepKeys } from "../queues.ts";
import { moveCompanyStatus, PROTECTED } from "./status.ts";

export interface DiscoveryStepResult {
  discoveryJobId: string;
  status: "succeeded" | "already_succeeded";
  found: number;
  created: number;
  updated: number;
  /** 公式サイト確認済みとして診断へ送った企業 */
  auditQueued: string[];
}

/**
 * 収集ジョブを実行し、公式サイトが確認済み（confirmed）で営業抑止のない企業を site_confirmed に進めて診断へ送る。
 * 公式サイトが候補・確認待ちの企業は collected のまま（運営の確認を待つ）。
 */
export const discoveryStep: StepDefinition<DiscoveryPayload, DiscoveryStepResult> = {
  queue: QUEUES.discovery,
  key: stepKeys.discovery,
  kind: "discovery",
  async run(deps, payload, ctx) {
    const { db, clock } = deps;
    const [job] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, payload.discoveryJobId));
    if (!job) throw new PreconditionError(`収集ジョブがない：${payload.discoveryJobId}`);

    let counts = { found: job.foundCount, created: job.createdCount, updated: job.updatedCount };
    let status: DiscoveryStepResult["status"] = "already_succeeded";
    if (job.status !== "succeeded") {
      const provider = deps.discovery.providers[job.provider];
      if (!provider) {
        await stopDiscoveryJob(
          deps,
          job.id,
          `取得元「${job.provider}」はこのワーカーで有効になっていません。設定後に再試行してください`,
        );
        throw new PreconditionError(`取得元「${job.provider}」はこのワーカーで有効になっていない`);
      }
      if (job.status === "running" && ctx.attempt > 1) {
        // このステップの前回の試行が途中で止まり、running のまま残っている
        await failRunningDiscoveryJob(db, clock, {
          jobId: job.id,
          actor: { kind: "system", job: "worker" },
          reason: "前回の試行が完了せずに中断された（再試行の前に失敗に戻した）",
        });
      }
      const r = await runDiscovery(db, clock, job.id, {
        signal: ctx.signal,
        searchLimit: deps.discovery.searchLimit,
        companies: provider,
        ...(deps.discovery.search ? { search: deps.discovery.search } : {}),
        ...(deps.discovery.thirdPartyDomains ? { thirdPartyDomains: deps.discovery.thirdPartyDomains } : {}),
      });
      if (!r.ok) {
        // job_already_running：別の実行が進行中（または停止して残っている。定期ジョブ・運営操作で失敗に戻す）
        if (r.error === "job_already_running") throw new Error(`収集ジョブが実行中：${r.message ?? ""}`);
        throw new PermanentError(`${r.error}: ${r.message ?? ""}`);
      }
      if (r.value.status === "failed") {
        const reason = r.value.failures.map((f) => f.reason).find(Boolean) ?? "収集に失敗";
        throw new Error(`収集に失敗した：${reason}`);
      }
      counts = { found: r.value.found, created: r.value.created, updated: r.value.updated };
      status = "succeeded";
    }

    const auditQueued = await advanceConfirmedCompanies(deps, job.id);
    return { discoveryJobId: job.id, status, ...counts, auditQueued };
  },
  onGiveUp: (deps, payload, reason) => stopDiscoveryJob(deps, payload.discoveryJobId, reason),
  summarize: (r) => r,
};

/**
 * 収集ジョブで見つかった企業のうち、公式サイト確認済み・営業抑止なしのものを site_confirmed に進め、診断へ送る。
 * すでに site_confirmed の企業（前回の試行で進めたが送る前に止まった等）も送る。診断側の冪等キーで二重実行しない。
 */
export async function advanceConfirmedCompanies(deps: WorkerDeps, discoveryJobId: string): Promise<string[]> {
  if (deps.discoveryOnly) return [];
  const { db, clock } = deps;
  const sources = await db
    .selectDistinct({ companyId: discoverySources.companyId })
    .from(discoverySources)
    .where(and(eq(discoverySources.jobId, discoveryJobId), eq(discoverySources.role, "company")));
  const ids = sources.map((s) => s.companyId).filter((id): id is string => !!id);
  if (ids.length === 0) return [];
  const rows = await db.select().from(companies).where(inArray(companies.id, ids));

  const queued: string[] = [];
  for (const c of rows) {
    if (c.officialSiteStatus !== "confirmed" || PROTECTED.includes(c.suppression)) continue;
    if (c.pipelineStatus === "collected") {
      await moveCompanyStatus(db, clock, {
        companyId: c.id,
        from: ["collected"],
        to: "site_confirmed",
        reason: "公式サイト確認済み",
        meta: { discoveryJobId },
      });
    } else if (c.pipelineStatus !== "site_confirmed") {
      continue;
    }
    const payload: AuditPayload = { companyId: c.id, requestKey: `discovery:${discoveryJobId}` };
    await deps.queue.send(QUEUES.audit, payload, { singletonKey: stepKeys.audit(payload) });
    queued.push(c.id);
  }
  return queued;
}

export type FailDiscoveryJobError = "job_not_found" | "not_running" | "forbidden";

/**
 * running のまま残った収集ジョブを failed に戻す（運営の操作・ワーカーの再試行から呼ぶ）。
 * 実際にまだ動いている実行があると、その終了処理が結果を上書きする。運営画面では、開始から十分時間が経ったものに限って操作させる。
 */
export async function failRunningDiscoveryJob(
  db: DbOrTx,
  clock: Clock,
  input: { jobId: string; actor: Actor; reason: string },
): Promise<Result<{ jobId: string }, FailDiscoveryJobError>> {
  if (input.actor.kind !== "ops" && input.actor.kind !== "system") return err("forbidden", "運営だけが操作できる");
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(discoveryJobs).where(eq(discoveryJobs.id, input.jobId));
    if (!job) return err("job_not_found");
    if (job.status !== "running") return err("not_running", `状態が ${job.status}`);
    const [updated] = await tx
      .update(discoveryJobs)
      .set({ status: "failed", error: input.reason.slice(0, 1000), finishedAt: clock.now() })
      .where(and(eq(discoveryJobs.id, input.jobId), eq(discoveryJobs.status, "running")))
      .returning({ id: discoveryJobs.id });
    if (!updated) return err("not_running");
    await recordEvent(tx, clock, {
      actor: input.actor,
      action: "discovery.job_marked_failed",
      targetType: "discovery_job",
      targetId: input.jobId,
      before: { status: "running", startedAt: job.startedAt?.toISOString() ?? null },
      after: { status: "failed", reason: input.reason },
    });
    return ok({ jobId: input.jobId });
  });
}

/**
 * 定期ジョブ：開始から staleAfterMs 以上 running のままの収集ジョブを failed に戻す。
 * 戻したジョブは再実行（新しい収集ジョブの作成、または同じジョブを再投入）できる。
 */
export async function recoverStaleDiscoveryJobs(db: Db, clock: Clock, staleAfterMs: number): Promise<string[]> {
  const threshold = new Date(clock.now().getTime() - staleAfterMs);
  const stale = await db
    .select({ id: discoveryJobs.id })
    .from(discoveryJobs)
    .where(and(eq(discoveryJobs.status, "running"), lt(discoveryJobs.startedAt, threshold)));
  const recovered: string[] = [];
  for (const j of stale) {
    const r = await failRunningDiscoveryJob(db, clock, {
      jobId: j.id,
      actor: { kind: "system", job: "discovery-recovery" },
      reason: `実行中のまま ${Math.round(staleAfterMs / 60000)} 分以上経過したため失敗に戻した（ワーカーの停止などで中断されたとみなす）`,
    });
    if (r.ok) recovered.push(j.id);
  }
  return recovered;
}

export async function stopDiscoveryJob(deps: Pick<WorkerDeps, "db" | "clock">, id: string, reason: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(discoveryJobs)
      .set({ status: "failed", error: reason.slice(0, 1000), finishedAt: deps.clock.now() })
      .where(and(eq(discoveryJobs.id, id), inArray(discoveryJobs.status, ["queued", "running"])))
      .returning({ id: discoveryJobs.id });
    if (row)
      await recordEvent(tx, deps.clock, {
        actor: { kind: "system", job: "discovery-recovery" },
        action: "discovery.job_stopped",
        targetType: "discovery_job",
        targetId: id,
        after: { reason: reason.slice(0, 1000) },
      });
  });
}
