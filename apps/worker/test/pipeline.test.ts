/**
 * パイプライン（収集 → 診断 → 生成 → 運営確認待ち）。PGlite・フィクスチャの取得元・モック生成器で確認する。
 * Astroのビルドはモック（実ビルドは pipeline-astro.test.ts の1回だけ）。モックでの成功は実生成の成功ではない。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  auditEvents,
  companies,
  discoveryJobs,
  generationJobs,
  proposalVersions,
  siteAudits,
  websites,
} from "@siteoffer/db";
import { createDiscoveryJob, FixtureProvider, MockSearchProvider, runDiscovery } from "@siteoffer/discovery";
import { type Generator, MockGenerator } from "@siteoffer/generation";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROPOSAL_CONTENT_KEYS, type ProposalContent } from "../src/content.ts";
import { executeStep } from "../src/execute.ts";
import { claimStep, readStepState, STEP_TARGET } from "../src/ledger.ts";
import { auditStep } from "../src/pipeline/audit.ts";
import { discoveryStep } from "../src/pipeline/discovery.ts";
import { proposalStep, requestRegeneration } from "../src/pipeline/proposal.ts";
import { type AuditPayload, type ProposalPayload, QUEUES, stepKeys } from "../src/queues.ts";
import {
  drainWithDesignApproval,
  fakeSiteBuilder,
  generationShapedEvaluation,
  ONE_COMPANY_CRITERIA,
  setupEnv,
  type TestEnv,
} from "./helpers.ts";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

async function startDiscovery(e: TestEnv, criteria: unknown = ONE_COMPANY_CRITERIA) {
  const job = await createDiscoveryJob(e.db, e.clock, { provider: "fixture", criteria });
  if (!job.ok) throw new Error(job.error);
  await e.queue.send(
    QUEUES.discovery,
    { discoveryJobId: job.value.jobId },
    { singletonKey: `discovery:${job.value.jobId}` },
  );
  return job.value.jobId;
}

async function company(e: TestEnv, name = "株式会社あおば印刷") {
  const [c] = await e.db.select().from(companies).where(eq(companies.name, name));
  return c!;
}

async function versions(e: TestEnv) {
  return e.db.select().from(proposalVersions).orderBy(asc(proposalVersions.version));
}

describe("パイプラインを最後まで通す", () => {
  it("判定が create なら、生成・デモのビルドを経て提案版を in_review で保存し、企業を in_review にする", async () => {
    const fake = fakeSiteBuilder();
    env = await setupEnv({ threshold: 100, siteBuilder: fake.builder });
    const jobId = await startDiscovery(env);
    const results = await drainWithDesignApproval(env);

    expect(results.map((r) => [r.name, r.outcome.status])).toEqual([
      [QUEUES.discovery, "succeeded"],
      [QUEUES.audit, "succeeded"],
      [QUEUES.proposal, "succeeded"],
    ]);
    const [job] = await env.db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId));
    expect(job!.status).toBe("succeeded");

    const c = await company(env);
    expect(c.officialSiteStatus).toBe("confirmed");
    expect(c.pipelineStatus).toBe("in_review");

    const [audit] = await env.db.select().from(siteAudits).where(eq(siteAudits.companyId, c.id));
    expect(audit).toMatchObject({ status: "evaluated", decision: "create" });

    const vs = await versions(env);
    expect(vs).toHaveLength(1);
    const v = vs[0]!;
    expect(v).toMatchObject({ version: 1, status: "in_review", auditId: audit!.id });
    expect(v.demoArtifactDir).toContain(c.id);
    const content = v.content as ProposalContent;
    for (const k of Object.values(PROPOSAL_CONTENT_KEYS)) expect(content[k]).not.toBeNull();
    expect(content.generator).toBe("mock");
    expect(content.demoCheck?.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);

    // 生成ジョブ：採点1件＋提案4件。すべてモック（モデル等は不明のまま null）
    const jobs = await env.db.select().from(generationJobs);
    expect(jobs.map((j) => j.purpose).sort()).toEqual([
      "call_script",
      "demo_site",
      "evaluation",
      "faq",
      "proposal_text",
    ]);
    expect(jobs.every((j) => j.generator === "mock" && j.status === "succeeded" && j.responseModel === null)).toBe(
      true,
    );
    expect(v.generationJobId).toBe(content.generationJobIds.demo_site);

    // 企業の状態遷移の履歴（18章「提案」）
    const transitions = await env.db
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "company.pipeline_status_changed"), eq(auditEvents.targetId, c.id)))
      .orderBy(asc(auditEvents.createdAt));
    expect(transitions.map((t) => (t.after as { pipelineStatus: string }).pipelineStatus)).toEqual([
      "site_confirmed",
      "audited",
      "generated",
      "in_review",
    ]);
  });

  it("閾値が未設定（null）なら判定保留（hold）で止め、生成しない", async () => {
    const fake = fakeSiteBuilder();
    env = await setupEnv({ threshold: null, siteBuilder: fake.builder });
    await startDiscovery(env);
    const results = await drainWithDesignApproval(env);
    expect(results.map((r) => r.name)).toEqual([QUEUES.discovery, QUEUES.audit]);
    const audit = results[1]!.outcome;
    expect(audit).toMatchObject({ status: "succeeded", result: { decision: "hold", proposalQueued: false } });

    const c = await company(env);
    expect(c.pipelineStatus).toBe("on_hold");
    expect(await versions(env)).toHaveLength(0);
    const jobs = await env.db.select().from(generationJobs);
    expect(jobs.map((j) => j.purpose)).toEqual(["evaluation"]);
    expect(fake.calls).toHaveLength(0);
    expect(env.queue.sent.filter((s) => s.name === QUEUES.proposal)).toHaveLength(0);
  });

  it("hold の診断で生成を直接投入しても、生成しない（再試行もしない）", async () => {
    env = await setupEnv({ threshold: null });
    await startDiscovery(env);
    await drainWithDesignApproval(env);
    const c = await company(env);
    const [audit] = await env.db.select().from(siteAudits).where(eq(siteAudits.companyId, c.id));
    const r = await executeStep(env.deps, proposalStep, { companyId: c.id, auditId: audit!.id, revision: "initial" });
    expect(r).toMatchObject({ status: "failed", attempt: 1 });
    if (r.status === "failed") expect(r.reason).toContain("create ではない");
    expect(await versions(env)).toHaveLength(0);
    expect((await company(env)).pipelineStatus).toBe("on_hold");
  });

  it("公式サイトが確認済みでない企業は診断へ送らない", async () => {
    env = await setupEnv({ threshold: 100 });
    await startDiscovery(env, { prefecture: "愛知県" });
    const results = await drainWithDesignApproval(env, { maxRuns: 200 });
    const audited = new Set(
      results
        .filter((r) => r.name === QUEUES.audit)
        .map((r) => (r.outcome as { result: { companyId: string } }).result.companyId),
    );
    const all = await env.db.select().from(companies);
    for (const c of all) {
      if (c.officialSiteStatus === "confirmed") expect(audited.has(c.id)).toBe(true);
      else {
        expect(audited.has(c.id)).toBe(false);
        expect(c.pipelineStatus).toBe("collected");
      }
    }
    expect(audited.size).toBeGreaterThan(1);
  });

  it("ワーカーで有効でない取得元（スクリプトで取り込んだ agent-web 等）の成功済みジョブは、診断へ送らない", async () => {
    env = await setupEnv({ threshold: 100 });
    // 取り込みスクリプトと同じく、ワーカーの外で収集を終えたジョブ（取得元の名前だけ agent-web にする）
    const agent = new FixtureProvider({ name: "agent-web" });
    const job = await createDiscoveryJob(env.db, env.clock, { provider: agent.name, criteria: ONE_COMPANY_CRITERIA });
    if (!job.ok) throw new Error(job.error);
    const r = await runDiscovery(env.db, env.clock, job.value.jobId, {
      companies: agent,
      search: new MockSearchProvider(),
    });
    expect(r).toMatchObject({ ok: true, value: { status: "succeeded", created: 1 } });
    expect((await company(env)).officialSiteStatus).toBe("confirmed");

    const out = await executeStep(env.deps, discoveryStep, { discoveryJobId: job.value.jobId });
    expect(out).toMatchObject({ status: "failed" });
    expect(env.queue.size).toBe(0);
    expect(await env.db.select().from(siteAudits)).toHaveLength(0);
    expect((await company(env)).pipelineStatus).toBe("collected");
  });
});

describe("二重投入", () => {
  it("同じ収集・診断・生成を二重に投入しても、1回しか実行しない", async () => {
    const fake = fakeSiteBuilder();
    env = await setupEnv({ threshold: 100, siteBuilder: fake.builder });
    const jobId = await startDiscovery(env);
    // キュー側：同じ singletonKey の未処理ジョブは1件に保つ
    await env.queue.send(QUEUES.discovery, { discoveryJobId: jobId }, { singletonKey: `discovery:${jobId}` });
    expect(env.queue.size).toBe(1);
    await drainWithDesignApproval(env);

    // 処理側：キューを通らない二重実行も冪等キーで止める
    const again = await executeStep(env.deps, discoveryStep, { discoveryJobId: jobId });
    expect(again).toMatchObject({ status: "duplicate", state: "succeeded" });
    const c = await company(env);
    const auditPayload = env.queue.sent.find((message) => message.name === QUEUES.audit)!.data as AuditPayload;
    expect(await executeStep(env.deps, auditStep, auditPayload)).toMatchObject({
      status: "duplicate",
      state: "succeeded",
    });
    const [audit] = await env.db.select().from(siteAudits).where(eq(siteAudits.companyId, c.id));
    const proposalPayload = { companyId: c.id, auditId: audit!.id, revision: "initial" };
    expect(await executeStep(env.deps, proposalStep, proposalPayload)).toMatchObject({
      status: "duplicate",
      state: "succeeded",
    });

    expect(await env.db.select().from(siteAudits)).toHaveLength(1);
    expect(await versions(env)).toHaveLength(1);
    expect(await env.db.select().from(generationJobs)).toHaveLength(5);
    expect(fake.calls).toHaveLength(1);
    const state = await readStepState(env.db, stepKeys.proposal(proposalPayload));
    expect(state).toMatchObject({ attempts: 1, succeeded: true, running: false });
  });

  it("実行中のキーは開始しない。制限時間を過ぎて残った試行は失敗として閉じ、再試行できる", async () => {
    env = await setupEnv({ threshold: 100, policies: { audit: { timeoutMs: 60_000 } } });
    const job = await createDiscoveryJob(env.db, env.clock, { provider: "fixture", criteria: ONE_COMPANY_CRITERIA });
    if (!job.ok) throw new Error(job.error);
    await executeStep(env.deps, discoveryStep, { discoveryJobId: job.value.jobId });
    const c = await company(env);
    const payload = { companyId: c.id, requestKey: "manual-1" };
    // 他のワーカーが開始した直後（終了の記録がない）を作る
    const claim = await claimStep(env.db, env.clock, {
      key: stepKeys.audit(payload),
      queue: QUEUES.audit,
      maxAttempts: 3,
      staleAfterMs: 60_000,
      actor: { kind: "system", job: "other-worker" },
    });
    expect(claim).toMatchObject({ kind: "claimed", attempt: 1 });
    expect(await executeStep(env.deps, auditStep, payload)).toMatchObject({ status: "duplicate", state: "running" });

    env.clock.advance(61_000);
    const r = await executeStep(env.deps, auditStep, payload);
    expect(r).toMatchObject({ status: "succeeded", attempt: 2 });
    const state = await readStepState(env.db, stepKeys.audit(payload));
    expect(state).toMatchObject({ attempts: 2, succeeded: true });
    expect(state.lastFailure).toContain("stale");
  });
});

describe("失敗・再試行・上限", () => {
  it("古いビルドが再試行の完了後に書き込んでも、採用済み成果物と状態を変えない", async () => {
    const fake = fakeSiteBuilder();
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let calls = 0;
    const paths: string[] = [];
    const builder = {
      ...fake.builder,
      async buildDemo(input: Parameters<typeof fake.builder.buildDemo>[0]) {
        const n = ++calls;
        const built = await fake.builder.buildDemo(input);
        if (!built.ok) throw new Error("fixture build failed");
        paths.push(built.distDir);
        if (n === 1) {
          ready();
          await gate;
        }
        await writeFile(path.join(built.distDir, "index.html"), n === 1 ? "old-attempt" : "current-attempt");
        return built;
      },
    };
    env = await setupEnv({ threshold: 100, siteBuilder: builder, policies: { proposal: { timeoutMs: 60_000 } } });
    const e = env;
    await startDiscovery(e);
    const original = drainWithDesignApproval(e);
    try {
      await started;
      const payload = [...e.queue.sent]
        .reverse()
        .find((s) => s.name === QUEUES.proposal && (s.data as ProposalPayload).designVersionId)!
        .data as ProposalPayload;
      e.clock.advance(60_001);
      expect(await executeStep(e.deps, proposalStep, payload)).toMatchObject({ status: "succeeded", attempt: 2 });
      const [current] = await versions(e);
      expect(current!.demoArtifactDir).toBe(paths[1]);
      release();
      expect((await original).at(-1)!.outcome).toMatchObject({ status: "superseded", attempt: 1 });
      expect(paths[0]).not.toBe(paths[1]);
      expect(await readFile(path.join(paths[1]!, "index.html"), "utf8")).toBe("current-attempt");
      expect(await readFile(path.join(paths[0]!, "index.html"), "utf8")).toBe("old-attempt");
      expect((await versions(e))[0]).toEqual(current);
      expect((await company(e)).pipelineStatus).toBe("in_review");
      expect(await readStepState(e.db, stepKeys.proposal(payload))).toMatchObject({
        attempts: 2,
        succeeded: true,
        gaveUp: false,
      });
      expect(await e.db.select().from(generationJobs)).toHaveLength(5); // 成功済みの生成は再利用
    } finally {
      release();
      await original;
    }
  });

  it("再試行後に戻った古い診断は採点確定・企業更新・提案送信へ進めない", async () => {
    env = await setupEnv({ threshold: 100, policies: { audit: { timeoutMs: 60_000 } } });
    const e = env;
    const job = await createDiscoveryJob(e.db, e.clock, { provider: "fixture", criteria: ONE_COMPANY_CRITERIA });
    if (!job.ok) throw new Error(job.error);
    await executeStep(e.deps, discoveryStep, { discoveryJobId: job.value.jobId });
    const c = await company(e);
    const payload = { companyId: c.id, requestKey: "stale-diagnosis" };
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const generator = e.deps.audit.generator;
    let calls = 0;
    e.deps.audit.generator = {
      async generate(input) {
        if (++calls === 1) {
          ready();
          await gate;
        }
        // 古い生成器の返答も有効なJSONにして、形式エラーで止まっただけの検証にしない。
        return generator.generate(input);
      },
    };
    const old = executeStep(e.deps, auditStep, payload);
    try {
      await started;
      e.clock.advance(60_001);
      expect(await executeStep(e.deps, auditStep, payload)).toMatchObject({ status: "succeeded", attempt: 2 });
      const sent = e.queue.sent.filter((s) => s.name === QUEUES.proposal).length;
      release();
      expect(await old).toMatchObject({ status: "superseded", attempt: 1 });
      expect(e.queue.sent.filter((s) => s.name === QUEUES.proposal)).toHaveLength(sent);
      const audits = await e.db.select().from(siteAudits);
      expect(audits.filter((a) => a.status === "evaluated")).toHaveLength(1);
      expect(audits.filter((a) => a.status === "failed")).toHaveLength(1);
      expect((await company(e)).pipelineStatus).toBe("audited");
    } finally {
      release();
      await old;
    }
  });

  it("診断の時間切れを採点へ伝え、診断を閉じて提案キューへ進めない", async () => {
    env = await setupEnv({ threshold: 100, policies: { audit: { timeoutMs: 2_000, maxAttempts: 1 } } });
    const e = env;
    const [c] = await e.db
      .insert(companies)
      .values({ name: "中断試験", officialSiteStatus: "confirmed", pipelineStatus: "site_confirmed" })
      .returning();
    await e.db.insert(websites).values({
      companyId: c!.id,
      url: "https://audit.example/",
      normalizedUrl: "https://audit.example/",
      domain: "audit.example",
      kind: "current",
      isPrimary: true,
    });
    let signal: AbortSignal | undefined;
    e.deps.audit.generator = {
      async generate(input) {
        signal = input.signal;
        return new Promise(() => {});
      },
    };
    expect(await executeStep(e.deps, auditStep, { companyId: c!.id, requestKey: "cancel-audit" })).toMatchObject({
      status: "failed",
    });
    expect(signal?.aborted).toBe(true);
    await vi.waitFor(async () => {
      const [audit] = await e.db.select().from(siteAudits);
      expect(audit).toMatchObject({ status: "failed", failureReason: expect.stringContaining("中断") });
    });
    const [current] = await e.db.select().from(companies).where(eq(companies.id, c!.id));
    expect(current!.pipelineStatus).toBe("failed");
    expect(e.queue.size).toBe(0);
    expect(await versions(e)).toHaveLength(0);
  });

  it("生成の失敗は再試行し、上限（3回）で止めて理由を記録し、提案版と企業を failed にする", async () => {
    const generator = new MockGenerator({
      overrides: { evaluation: generationShapedEvaluation(), proposal_text: { summary: "" } },
    });
    env = await setupEnv({ threshold: 100, generator });
    await startDiscovery(env);
    const results = await drainWithDesignApproval(env);
    expect(results.map((r) => `${r.name}:${r.outcome.status}`)).toEqual([
      `${QUEUES.discovery}:succeeded`,
      `${QUEUES.audit}:succeeded`,
      `${QUEUES.proposal}:retry`,
      `${QUEUES.proposal}:retry`,
      `${QUEUES.proposal}:failed`,
    ]);

    const c = await company(env);
    expect(c.pipelineStatus).toBe("failed");
    const vs = await versions(env);
    expect(vs).toHaveLength(1); // 再試行は同じ版を使う
    expect(vs[0]!.status).toBe("failed");
    expect((vs[0]!.content as ProposalContent).failure).toContain("proposal_text");

    const [audit] = await env.db.select().from(siteAudits).where(eq(siteAudits.companyId, c.id));
    const key = stepKeys.proposal({
      companyId: c.id,
      auditId: audit!.id,
      revision: "initial",
      designVersionId: (vs[0]!.content as ProposalContent).designVersionId,
    });
    const state = await readStepState(env.db, key);
    expect(state).toMatchObject({ attempts: 3, gaveUp: true, succeeded: false, running: false });
    expect(state.lastFailure).toContain("schema_violation");
    const failures = await env.db
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, STEP_TARGET),
          eq(auditEvents.targetId, key),
          eq(auditEvents.action, "worker.step_failed"),
        ),
      );
    expect(failures.map((f) => (f.after as { attempt: number; final: boolean }).final)).toEqual([false, false, true]);
    // 試行ごとに別の生成ジョブ（冪等キーに試行番号を含める）。失敗した用途だけが記録される
    const jobs = await env.db.select().from(generationJobs).where(eq(generationJobs.purpose, "proposal_text"));
    expect(jobs.map((j) => j.status)).toEqual(["failed", "failed", "failed"]);

    // 上限に達したキーは、もう一度投入しても実行しない
    const again = await executeStep(env.deps, proposalStep, {
      designVersionId: (vs[0]!.content as ProposalContent).designVersionId,
      companyId: c.id,
      auditId: audit!.id,
      revision: "initial",
    });
    expect(again).toMatchObject({ status: "duplicate", state: "gave_up" });
  });

  it("生成の停止が未確認なら親の提案工程も自動再試行せず止める", async () => {
    const base = new MockGenerator({ overrides: { evaluation: generationShapedEvaluation() } });
    let calls = 0;
    const generator: Generator = {
      kind: "mock",
      requestedModel: null,
      promptVersion: (purpose) => base.promptVersion(purpose),
      async generate(req) {
        if (req.purpose === "evaluation") return base.generate(req);
        calls++;
        return {
          ok: false,
          error: "sandbox_stop_unconfirmed",
          message: "生成処理の停止を確認できません。",
          record: {
            generator: "mock",
            requestedModel: null,
            responseModel: null,
            sdkVersion: null,
            cliVersion: null,
            promptVersion: "test",
            threadId: null,
            requestId: null,
            usage: null,
          },
        };
      },
    };
    env = await setupEnv({ threshold: 100, generator: base });
    env.deps.generation.generator = generator;
    await startDiscovery(env);
    const results = await drainWithDesignApproval(env);
    expect(results.map((r) => `${r.name}:${r.outcome.status}`)).toEqual([
      `${QUEUES.discovery}:succeeded`,
      `${QUEUES.audit}:succeeded`,
      `${QUEUES.proposal}:failed`,
    ]);
    expect(calls).toBe(1);
    expect(env.queue.size).toBe(0);
    expect(await versions(env)).toMatchObject([{ status: "failed" }]);
    expect(await env.db.select().from(generationJobs).where(eq(generationJobs.purpose, "proposal_text"))).toMatchObject(
      [{ status: "needs_review", attempts: 1, errorCode: "sandbox_stop_unconfirmed", output: null }],
    );
  });

  it("前の試行で成功した生成は、再試行で再実行しない", async () => {
    const fake = fakeSiteBuilder({ ok: false, retryable: true });
    env = await setupEnv({ threshold: 100, siteBuilder: fake.builder, policies: { proposal: { maxAttempts: 2 } } });
    await startDiscovery(env);
    const results = await drainWithDesignApproval(env);
    expect(results.slice(-2).map((r) => r.outcome.status)).toEqual(["retry", "failed"]);
    expect(fake.calls).toHaveLength(2);
    const jobs = await env.db.select().from(generationJobs);
    // 採点1件＋提案4件（2回目の試行は1回目の成功を使う）
    expect(jobs).toHaveLength(5);
  });

  it("制限時間を過ぎた試行は打ち切って失敗として記録する", async () => {
    const fake = fakeSiteBuilder({ hang: true });
    env = await setupEnv({
      threshold: 100,
      siteBuilder: fake.builder,
      policies: { proposal: { timeoutMs: 200, maxAttempts: 1 } },
    });
    await startDiscovery(env);
    const results = await drainWithDesignApproval(env);
    const last = results.at(-1)!.outcome;
    expect(last.status).toBe("failed");
    if (last.status === "failed") expect(last.reason).toContain("StepTimeoutError");
  });

  it("提案の制限時間後も生成が終了しなければ停止確認待ちにし、後続の生成・ビルドを始めない", async () => {
    const fake = fakeSiteBuilder(),
      mock = new MockGenerator({ overrides: { evaluation: generationShapedEvaluation() } });
    let signal: AbortSignal | undefined,
      calls = 0;
    const generator: Generator = {
      kind: "abort-proposal-test",
      requestedModel: null,
      promptVersion: (purpose) => mock.promptVersion(purpose),
      generate: (req) => {
        if (req.purpose === "evaluation") return mock.generate(req);
        calls++;
        signal = req.signal;
        return new Promise<never>(() => {});
      },
    };
    env = await setupEnv({
      threshold: 100,
      generator: mock,
      siteBuilder: fake.builder,
      policies: { proposal: { timeoutMs: 1000, maxAttempts: 1 } },
    });
    env.deps.generation.generator = generator;
    env.deps.generation.limits = { ...env.deps.generation.limits, stopTimeoutMs: 10 };
    await startDiscovery(env);
    const results = await drainWithDesignApproval(env);
    expect(results.at(-1)!.outcome).toMatchObject({ status: "failed" });
    expect(signal?.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(fake.calls).toHaveLength(0);
    await expect
      .poll(async () => {
        const [job] = await env!.db.select().from(generationJobs).where(eq(generationJobs.purpose, "proposal_text"));
        return job?.status;
      })
      .toBe("needs_review");
    const [job] = await env.db.select().from(generationJobs).where(eq(generationJobs.purpose, "proposal_text"));
    expect(job).toMatchObject({ errorCode: "sandbox_stop_unconfirmed", attempts: 1, output: null });
    expect((await versions(env))[0]!.status).toBe("failed");
  });

  it("デモの検査に通らない（再試行で変わらない）失敗は、1回で止める", async () => {
    const fake = fakeSiteBuilder({ ok: false, retryable: false });
    env = await setupEnv({ threshold: 100, siteBuilder: fake.builder });
    await startDiscovery(env);
    const results = await drainWithDesignApproval(env);
    expect(results.at(-1)!.outcome).toMatchObject({ status: "failed", attempt: 1 });
    expect((await versions(env))[0]!.status).toBe("failed");
  });
});

describe("再生成", () => {
  it("再生成は新しい版として保存し、契約で使われた版（承認済み）は変えない", async () => {
    env = await setupEnv({ threshold: 100 });
    await startDiscovery(env);
    await drainWithDesignApproval(env);
    const c = await company(env);
    const [v1] = await versions(env);
    // 運営が承認し、営業可能にした（契約で選ばれる版）
    await env.db.update(proposalVersions).set({ status: "approved" }).where(eq(proposalVersions.id, v1!.id));
    await env.db.update(companies).set({ pipelineStatus: "sellable" }).where(eq(companies.id, c.id));

    const payload = await requestRegeneration(env.queue, { companyId: c.id, auditId: v1!.auditId! });
    expect(payload.revision).toMatch(/^regen:/);
    const results = await drainWithDesignApproval(env);
    expect(results.map((r) => r.outcome.status)).toEqual(["succeeded"]);

    const vs = await versions(env);
    expect(vs.map((v) => [v.version, v.status])).toEqual([
      [1, "approved"],
      [2, "in_review"],
    ]);
    expect(vs[0]!.content).toEqual(v1!.content);
    expect(vs[0]!.demoArtifactDir).toBe(v1!.demoArtifactDir);
    expect(vs[1]!.demoArtifactDir).not.toBe(v1!.demoArtifactDir);
    // 営業可能の企業を運営確認待ちへ戻さない
    expect((await company(env)).pipelineStatus).toBe("sellable");
  });
});
