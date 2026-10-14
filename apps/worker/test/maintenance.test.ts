/** 定期ジョブ（担当の期限解除・実行中のまま残った収集ジョブの回復）と、運営の操作 */
import { HOUR } from "@siteoffer/core";
import { assignments, companies, discoveryJobs, users } from "@siteoffer/db";
import { createDiscoveryJob } from "@siteoffer/discovery";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { executeStep } from "../src/execute.ts";
import { discoveryStep, failRunningDiscoveryJob } from "../src/pipeline/discovery.ts";
import { QUEUES } from "../src/queues.ts";
import { ONE_COMPANY_CRITERIA, setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

describe("担当の期限解除（定期ジョブ）", () => {
  it("未着手・営業中で期限を過ぎた担当は解除し、商談中は運営確認待ちにする。再実行しても変わらない", async () => {
    env = await setupEnv();
    const { db, clock } = env;
    const [u] = await db
      .insert(users)
      .values({ email: "sales@example.test", passwordHash: "x", displayName: "営業", role: "sales" })
      .returning();
    const [c1, c2, c3, c4] = await db
      .insert(companies)
      .values([
        { name: "架空A", pipelineStatus: "sellable" },
        { name: "架空B", pipelineStatus: "sellable" },
        { name: "架空C", pipelineStatus: "sellable" },
        { name: "架空D", pipelineStatus: "sellable" },
      ])
      .returning();
    const now = clock.now();
    const past = new Date(now.getTime() - HOUR);
    const future = new Date(now.getTime() + HOUR);
    const [unstarted, working, notYet, negotiating] = await db
      .insert(assignments)
      .values([
        { companyId: c1!.id, userId: u!.id, status: "claimed", claimedAt: past, expiresAt: past },
        { companyId: c2!.id, userId: u!.id, status: "working", claimedAt: past, expiresAt: past, lastActivityAt: past },
        { companyId: c3!.id, userId: u!.id, status: "claimed", claimedAt: now, expiresAt: future },
        {
          companyId: c4!.id,
          userId: u!.id,
          status: "negotiating",
          claimedAt: past,
          expiresAt: past,
          lastActivityAt: past,
        },
      ])
      .returning();

    const r = await env.runtime.run(QUEUES.expireAssignments, {});
    expect(r).toEqual({
      status: "maintenance",
      result: { released: [unstarted!.id, working!.id], escalated: [negotiating!.id] },
    });
    const rows = new Map((await db.select().from(assignments)).map((a) => [a.id, a]));
    expect(rows.get(unstarted!.id)).toMatchObject({ status: "released", releaseReason: "unstarted_timeout" });
    expect(rows.get(working!.id)).toMatchObject({ status: "released", releaseReason: "working_timeout" });
    expect(rows.get(negotiating!.id)!.status).toBe("awaiting_ops");
    expect(rows.get(notYet!.id)!.status).toBe("claimed");

    expect(await env.runtime.run(QUEUES.expireAssignments, {})).toEqual({
      status: "maintenance",
      result: { released: [], escalated: [] },
    });
  });
});

describe("実行中のまま残った収集ジョブ", () => {
  async function stuckJob(e: TestEnv) {
    const job = await createDiscoveryJob(e.db, e.clock, { provider: "fixture", criteria: ONE_COMPANY_CRITERIA });
    if (!job.ok) throw new Error(job.error);
    // 実行中にワーカーが落ちた状態
    await e.db
      .update(discoveryJobs)
      .set({ status: "running", startedAt: e.clock.now(), attempts: 1 })
      .where(eq(discoveryJobs.id, job.value.jobId));
    return job.value.jobId;
  }

  it("一定時間を過ぎたら定期ジョブで failed に戻し、その後に再実行できる", async () => {
    env = await setupEnv();
    const jobId = await stuckJob(env);

    // 時間が経つ前は戻さない
    expect(await env.runtime.run(QUEUES.recoverDiscovery, {})).toEqual({
      status: "maintenance",
      result: { recovered: [] },
    });
    env.clock.advance(env.deps.discoveryStaleAfterMs + 1000);
    expect(await env.runtime.run(QUEUES.recoverDiscovery, {})).toEqual({
      status: "maintenance",
      result: { recovered: [jobId] },
    });
    const [job] = await env.db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId));
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("実行中のまま");

    const r = await executeStep(env.deps, discoveryStep, { discoveryJobId: jobId });
    expect(r.status).toBe("succeeded");
    const [after] = await env.db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId));
    expect(after).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("運営は失敗に戻せる。営業ユーザーは操作できない。実行中でないジョブは対象外", async () => {
    env = await setupEnv();
    const jobId = await stuckJob(env);
    const [ops] = await env.db
      .insert(users)
      .values({ email: "ops@example.test", passwordHash: "x", displayName: "運営", role: "ops" })
      .returning();

    const bySales = await failRunningDiscoveryJob(env.db, env.clock, {
      jobId,
      actor: { kind: "sales", userId: ops!.id },
      reason: "x",
    });
    expect(bySales).toMatchObject({ ok: false, error: "forbidden" });
    const byOps = await failRunningDiscoveryJob(env.db, env.clock, {
      jobId,
      actor: { kind: "ops", userId: ops!.id },
      reason: "運営が中断を確認",
    });
    expect(byOps.ok).toBe(true);
    const again = await failRunningDiscoveryJob(env.db, env.clock, {
      jobId,
      actor: { kind: "ops", userId: ops!.id },
      reason: "運営が中断を確認",
    });
    expect(again).toMatchObject({ ok: false, error: "not_running" });
  });

  it("収集ステップの再試行は、前の試行で running のまま残ったジョブを失敗に戻してから実行する", async () => {
    env = await setupEnv({ policies: { discovery: { timeoutMs: 1000 } } });
    const jobId = await stuckJob(env);
    // 前の試行（このステップ）が開始の記録だけ残して止まった
    const first = await executeStep(env.deps, discoveryStep, { discoveryJobId: jobId });
    expect(first.status).toBe("retry"); // job_already_running
    // 1回目の試行の記録は閉じている（失敗）。2回目の試行では running のジョブを失敗に戻して実行する
    const second = await executeStep(env.deps, discoveryStep, { discoveryJobId: jobId });
    expect(second).toMatchObject({ status: "succeeded", attempt: 2 });
  });
});
