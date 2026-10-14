/**
 * 受付処理（DBを見てジョブを拾う）と、デモ用の設定（評価設定・生成の入力）の確認。
 * 生成はモック（fixtures/codex の固定応答）。モックでの成功は実生成の成功ではない（24.3）。
 * Astroの実ビルドは、このファイルでは納品サイト（mode=delivery）の1回だけ。
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeliveryForContract, fixedClock, transitionDelivery } from "@siteoffer/core";
import {
  assignments,
  companies,
  contracts,
  type Db,
  deliveries,
  deliveryVersions,
  discoveryJobs,
  proposals,
  proposalVersions,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { createDiscoveryJob } from "@siteoffer/discovery";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorkerDeps, resolveWorkerConfig } from "../src/config.ts";
import { silentLogger, type WorkerDeps } from "../src/deps.ts";
import {
  createIntakeState,
  deliveryRoundKey,
  intakeDeliveries,
  intakeDiscoveryJobs,
  runIntakeOnce,
} from "../src/intake.ts";
import { createWorkerRuntime, InMemoryQueue } from "../src/runtime.ts";
import { createAstroSiteBuilder } from "../src/site-builder.ts";
import { fakeSiteBuilder } from "./helpers.ts";

const DEMO_ENV = {
  SITEOFFER_GENERATOR: "mock",
  SITEOFFER_EVAL_CONFIG: "config/site-evaluation.demo.json",
  SITEOFFER_GENERATION_INPUT: "fixture",
};

describe("設定", () => {
  it("SITEOFFER_EVAL_CONFIG で評価設定を差し替えられる。既定は config/site-evaluation.json", () => {
    const def = resolveWorkerConfig({});
    if (!def.ok) throw new Error(def.message);
    expect(def.value.auditOptions.paths.configPath.endsWith("config/site-evaluation.json")).toBe(true);
    expect(def.value.generationInput).toBe("default");
    expect(def.value.intakeIntervalMs).toBe(5000);

    const demo = resolveWorkerConfig({ ...DEMO_ENV, SITEOFFER_INTAKE_INTERVAL_MS: "2000" });
    if (!demo.ok) throw new Error(demo.message);
    expect(demo.value.auditOptions.paths.configPath.endsWith("config/site-evaluation.demo.json")).toBe(true);
    expect(demo.value.generationInput).toBe("fixture");
    expect(demo.value.intakeIntervalMs).toBe(2000);
  });

  it("存在しない評価設定・実生成での固定入力・不正な間隔は設定エラー", () => {
    expect(resolveWorkerConfig({ SITEOFFER_EVAL_CONFIG: "config/none.json" }).ok).toBe(false);
    const codex = resolveWorkerConfig({
      SITEOFFER_GENERATOR: "codex",
      SITEOFFER_CODEX_IMAGE: "img",
      SITEOFFER_CODEX_NETWORK: "net",
      SITEOFFER_CODEX_AUTH_FILE: "/dev/null",
      SITEOFFER_GENERATION_INPUT: "fixture",
    });
    expect(codex.ok).toBe(false);
    expect(resolveWorkerConfig({ SITEOFFER_INTAKE_INTERVAL_MS: "-1" }).ok).toBe(false);
    expect(resolveWorkerConfig({ SITEOFFER_PROPOSAL_CONCURRENCY: "0" }).ok).toBe(false);
    const one = resolveWorkerConfig({ SITEOFFER_PROPOSAL_CONCURRENCY: "1" });
    expect(one.ok && one.value.concurrency.proposal).toBe(1);
  });

  it("デモ用の評価設定は閾値などの値だけが違い、仮値であることを明記している", async () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const base = JSON.parse(await readFile(path.join(root, "config/site-evaluation.json"), "utf8"));
    const demo = JSON.parse(await readFile(path.join(root, "config/site-evaluation.demo.json"), "utf8"));
    expect(base.proposal.threshold).toBeNull();
    expect(demo._comment).toContain("デモ用の仮値。ユーザーが決めた値ではない");
    expect(typeof demo.proposal.threshold).toBe("number");
    expect(demo.proposal.critical_flags_trigger).toBe(true);
    expect(demo.category_weights).toEqual(base.category_weights);
    expect(demo.proposal.min_coverage).toBe(base.proposal.min_coverage);
  });
});

/** デモの設定（評価設定・固定入力・モック生成器）でワーカーの部品を組み立てる。ビルドは差し替え */
async function setupDemo(db: Db, dir: string, clock: ReturnType<typeof fixedClock>) {
  const resolved = resolveWorkerConfig({ ...DEMO_ENV, SITEOFFER_AUDIT_ARTIFACT_DIR: path.join(dir, "audits") });
  if (!resolved.ok) throw new Error(resolved.message);
  const config = {
    ...resolved.value,
    auditOptions: { ...resolved.value.auditOptions, screenshot: false },
    demoArtifactRoot: path.join(dir, "demos"),
    deliveryArtifactRoot: path.join(dir, "deliveries"),
  };
  const queue = new InMemoryQueue();
  const fake = fakeSiteBuilder();
  const deps: WorkerDeps = {
    ...buildWorkerDeps(config, { db, clock, queue, logger: silentLogger }),
    siteBuilder: fake.builder,
  };
  return { deps, queue, fake, runtime: createWorkerRuntime(deps) };
}

describe("デモの流れ（受付 → 収集 → 診断 → 生成 → 納品版）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let dir: string;
  const clock = fixedClock("2026-10-14T06:00:00Z");
  let env: Awaited<ReturnType<typeof setupDemo>>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    dir = await mkdtemp(path.join(os.tmpdir(), "siteoffer-intake-"));
    env = await setupDemo(db, dir, clock);
  });
  afterAll(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });

  it("queued の収集ジョブを1回だけ投入し、デモ用の評価設定で架空企業が create → in_review まで進む", async () => {
    const job = await createDiscoveryJob(db, clock, { provider: "fixture", criteria: {} });
    if (!job.ok) throw new Error(job.error);
    const state = createIntakeState();

    expect(await intakeDiscoveryJobs(env.deps, state)).toEqual([job.value.jobId]);
    // まだ queued のまま（ワーカーが拾う前）でも、二度目は送らない
    expect(await intakeDiscoveryJobs(env.deps, state)).toEqual([]);
    // 別のプロセス（状態なし）が送っても、キュー側の singletonKey で1件に保たれる
    await intakeDiscoveryJobs(env.deps, createIntakeState());
    expect(env.queue.size).toBe(1);

    const results = await env.queue.drain(env.runtime);
    expect(results.every((r) => r.outcome.status === "succeeded")).toBe(true);
    const [j] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, job.value.jobId));
    expect(j!.status).toBe("succeeded");
    // 実行後は queued ではないので拾わない
    expect(await intakeDiscoveryJobs(env.deps, createIntakeState())).toEqual([]);

    const confirmed = await db.select().from(companies).where(eq(companies.officialSiteStatus, "confirmed"));
    expect(confirmed.length).toBeGreaterThan(0);
    expect(confirmed.every((c) => c.pipelineStatus === "in_review")).toBe(true);
    const versions = await db.select().from(proposalVersions);
    expect(versions.length).toBe(confirmed.length);
    expect(versions.every((v) => v.status === "in_review")).toBe(true);
  });

  it("制作中の納品に版を1つ追加して運営確認へ進め、制作へ戻すと新しい回の版を作る", async () => {
    const [company] = await db
      .select()
      .from(companies)
      .where(eq(companies.pipelineStatus, "in_review"))
      .orderBy(asc(companies.name))
      .limit(1);
    const [row] = await db
      .select({ pv: proposalVersions })
      .from(proposalVersions)
      .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
      .where(eq(proposals.companyId, company!.id));
    const contractId = await completedContract(db, company!.id, row!.pv.id);
    const system = { kind: "system", job: "test" } as const;
    const created = await createDeliveryForContract(db, clock, system, contractId);
    if (!created.ok) throw new Error(created.error);
    const deliveryId = created.value.delivery.id;
    const state = createIntakeState();
    const buildsBefore = env.fake.calls.length;

    // 情報確認中は拾わない
    expect(await intakeDeliveries(env.deps, state)).toEqual([]);
    clock.advance(1000);
    const toBuilding = await transitionDelivery(db, clock, system, deliveryId, "building");
    if (!toBuilding.ok) throw new Error(toBuilding.error);

    const first = await runIntakeOnce(env.deps, state);
    expect(first.deliveries).toMatchObject([
      { deliveryId, status: "version_added", version: 1, movedToOpsReview: true },
    ]);
    const [d1] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
    expect(d1!.status).toBe("ops_review");
    // 運営確認中は拾わない（二重に版を作らない）
    expect((await runIntakeOnce(env.deps, state)).deliveries).toEqual([]);
    expect(env.fake.calls.length).toBe(buildsBefore + 1);

    // 運営確認で差し戻す → 新しい回
    clock.advance(1000);
    const back = await transitionDelivery(db, clock, { kind: "system", job: "test" }, deliveryId, "building");
    if (!back.ok) throw new Error(back.error);
    const second = await intakeDeliveries(env.deps, state);
    expect(second).toMatchObject([{ deliveryId, status: "version_added", version: 2, movedToOpsReview: true }]);

    const vs = await db
      .select()
      .from(deliveryVersions)
      .where(eq(deliveryVersions.deliveryId, deliveryId))
      .orderBy(asc(deliveryVersions.version));
    expect(vs.map((v) => v.version)).toEqual([1, 2]);
    expect(vs[0]!.artifactDir).not.toBe(vs[1]!.artifactDir);
    expect(vs.every((v) => v.artifactDir!.startsWith(env.deps.deliveryArtifactRoot))).toBe(true);
    expect(vs.every((v) => v.generationJobId !== null)).toBe(true);
  });

  it("その回の版があって制作中のまま（運営確認への移動の前に止まった）なら、版を作らずに移動だけ行う", async () => {
    const [d] = await db.select().from(deliveries).limit(1);
    clock.advance(1000);
    const back = await transitionDelivery(db, clock, { kind: "system", job: "test" }, d!.id, "building");
    if (!back.ok) throw new Error(back.error);
    // 版だけ先に入った状態を作る
    const [latest] = await db.select().from(deliveries).where(eq(deliveries.id, d!.id));
    await db.insert(deliveryVersions).values({
      deliveryId: d!.id,
      version: 3,
      artifactDir: path.join(env.deps.deliveryArtifactRoot, "manual"),
      createdAt: clock.now(),
    });
    const calls = env.fake.calls.length;
    const r = await intakeDeliveries(env.deps, createIntakeState());
    expect(r).toEqual([{ deliveryId: d!.id, status: "moved_to_ops_review", movedToOpsReview: true }]);
    expect(env.fake.calls.length).toBe(calls);
    expect(deliveryRoundKey(latest!)).toContain(d!.id);
  });

  it("ビルドに失敗した回は記録して、同じプロセスでは繰り返さない", async () => {
    const [d] = await db.select().from(deliveries).limit(1);
    clock.advance(1000);
    const back = await transitionDelivery(db, clock, { kind: "system", job: "test" }, d!.id, "building");
    if (!back.ok) throw new Error(back.error);
    const failing = fakeSiteBuilder({ ok: false, retryable: false });
    const deps = { ...env.deps, siteBuilder: failing.builder };
    const state = createIntakeState();
    const r = await intakeDeliveries(deps, state);
    expect(r[0]).toMatchObject({ deliveryId: d!.id, status: "failed" });
    expect(await intakeDeliveries(deps, state)).toEqual([]);
    expect(failing.calls.length).toBe(1);
    const [after] = await db.select().from(deliveries).where(eq(deliveries.id, d!.id));
    expect(after!.status).toBe("building");
  });

  it("納品サイトをAstroで実ビルド（mode=delivery）・検査して版を追加する", async () => {
    const [d] = await db.select().from(deliveries).limit(1);
    clock.advance(1000);
    const deps = { ...env.deps, siteBuilder: createAstroSiteBuilder({ timeoutMs: 240_000 }) };
    // 前のテストでビルドに失敗した回（building のまま）を、ワーカーの再起動後（状態なし）として拾い直す。生成は前回の結果を使う
    const r = await intakeDeliveries(deps, createIntakeState());
    expect(r).toMatchObject([{ deliveryId: d!.id, status: "version_added", movedToOpsReview: true }]);
    const [v] = await db
      .select()
      .from(deliveryVersions)
      .where(eq(deliveryVersions.deliveryId, d!.id))
      .orderBy(asc(deliveryVersions.createdAt), asc(deliveryVersions.version))
      .then((rows) => rows.slice(-1));
    const dist = v!.artifactDir!;
    expect(existsSync(path.join(path.dirname(dist), "site.json"))).toBe(true);
    const page = await readFile(path.join(dist, "index.html"), "utf8");
    // 納品サイトにはデモの「非公式」表示を入れない
    expect(page).not.toContain("非公式");
  }, 300_000);
});

/** 完了した契約を直接作る（契約確認の流れは packages/core のテストで確認済み） */
async function completedContract(db: Db, companyId: string, proposalVersionId: string): Promise<string> {
  const [sales] = await db
    .insert(users)
    .values({ email: "sales-intake@example.test", passwordHash: "x", displayName: "営業（テスト）", role: "sales" })
    .returning();
  const [a] = await db
    .insert(assignments)
    .values({ companyId, userId: sales!.id, status: "negotiating", claimedAt: new Date("2026-10-01") })
    .returning();
  const [c] = await db
    .insert(contracts)
    .values({
      companyId,
      assignmentId: a!.id,
      salesUserId: sales!.id,
      status: "completed",
      proposalVersionId,
      reportedAt: new Date("2026-10-02"),
      completedAt: new Date("2026-10-03"),
    })
    .returning();
  return c!.id;
}
