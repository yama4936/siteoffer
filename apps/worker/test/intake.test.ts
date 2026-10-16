/**
 * 受付処理（DBを見てジョブを拾う）と、デモ用の設定（評価設定・生成の入力）の確認。
 * 生成はモック（fixtures/codex の固定応答）。モックでの成功は実生成の成功ではない（24.3）。
 * Astroの実ビルドは、このファイルでは納品サイト（mode=delivery）の1回だけ。
 */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  attachImageAssetFile,
  createDeliveryForContract,
  DELIVERY_BUILD_LEASE_MS,
  decideAsCustomer,
  fixedClock,
  retryDeliveryBuild,
  sendToCustomerReview,
  transitionDelivery,
} from "@siteoffer/core";
import {
  approvals,
  assignments,
  companies,
  contentEntries,
  contracts,
  type Db,
  deliveries,
  deliveryBuilds,
  deliveryVersions,
  discoveryJobs,
  generationJobs,
  imageAssets,
  proposals,
  proposalVersions,
  siteAudits,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { createDiscoveryJob } from "@siteoffer/discovery";
import { asc, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedDeliveryBase } from "../../../packages/core/src/delivery/test-helpers.ts";
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
import { drainWithDesignApproval, fakeSiteBuilder } from "./helpers.ts";

const DEMO_ENV = {
  SITEOFFER_GENERATOR: "mock",
  SITEOFFER_EVAL_CONFIG: "config/site-evaluation.demo.json",
  SITEOFFER_GENERATION_INPUT: "fixture",
};

describe("設定", () => {
  it("SITEOFFER_EVAL_CONFIG で評価設定を差し替えられる。既定は config/site-evaluation.json", () => {
    const def = resolveWorkerConfig({});
    if (!def.ok) throw new Error(def.message);
    expect(def.value.auditOptions.paths.configPath.replaceAll("\\", "/").endsWith("config/site-evaluation.json")).toBe(
      true,
    );
    expect(def.value.generationInput).toBe("default");
    expect(def.value.intakeIntervalMs).toBe(5000);

    const demo = resolveWorkerConfig({ ...DEMO_ENV, SITEOFFER_INTAKE_INTERVAL_MS: "2000" });
    if (!demo.ok) throw new Error(demo.message);
    expect(
      demo.value.auditOptions.paths.configPath.replaceAll("\\", "/").endsWith("config/site-evaluation.demo.json"),
    ).toBe(true);
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

    const results = await drainWithDesignApproval(env);
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

    // 同じ時刻でも運営確認で差し戻すと新しい回になる
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
      buildId: latest!.currentBuildId,
      artifactDir: path.join(env.deps.deliveryArtifactRoot, "manual"),
      createdAt: clock.now(),
    });
    const calls = env.fake.calls.length;
    const r = await intakeDeliveries(env.deps, createIntakeState());
    expect(r).toEqual([{ deliveryId: d!.id, status: "moved_to_ops_review", movedToOpsReview: true }]);
    expect(env.fake.calls.length).toBe(calls);
    expect(deliveryRoundKey(latest!)).toContain(d!.id);
  });

  it("ビルドに失敗した回はDBに残り、プロセスを再起動しても繰り返さない", async () => {
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
    expect(await intakeDeliveries(deps, createIntakeState())).toEqual([]);
    expect(failing.calls.length).toBe(1);
    const [after] = await db.select().from(deliveries).where(eq(deliveries.id, d!.id));
    expect(after!.status).toBe("building");
  });

  it("納品サイトをAstroで実ビルド（mode=delivery）・検査して版を追加する", async () => {
    const [d] = await db.select().from(deliveries).limit(1);
    clock.advance(1000);
    const deps = { ...env.deps, siteBuilder: createAstroSiteBuilder({ timeoutMs: 240_000 }) };
    const [contract] = await db.select().from(contracts).where(eq(contracts.id, d!.contractId));
    const [materialOps] = await db.select().from(users).where(eq(users.role, "ops")).limit(1);
    const [material] = await db
      .insert(imageAssets)
      .values({
        companyId: contract!.companyId,
        label: "顧客提供の確認済みメイン画像",
        sourceType: "customer_upload",
        placement: "hero",
      })
      .returning();
    const materialPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUyNvCwMDAxMDAwMDAAAAOrgFGyLjQ8AAAAABJRU5ErkJggg==",
      "base64",
    );
    await attachImageAssetFile(
      db,
      clock,
      { kind: "ops", userId: materialOps!.id },
      { companyId: contract!.companyId, assetId: material!.id, png: materialPng, width: 2, height: 2 },
    );
    await db
      .update(imageAssets)
      .set({
        rightsStatus: "use_approved",
        allowProduction: true,
        confirmedBy: materialOps!.id,
        confirmedAt: clock.now(),
      })
      .where(eq(imageAssets.id, material!.id));
    await db
      .insert(contentEntries)
      .values({ companyId: contract!.companyId, slug: "delivery-news", updatedAt: clock.now() });
    await retryLatest(db, clock, d!.id);
    vi.stubEnv("SITEOFFER_CONTENT_ORIGIN", "");
    expect(await intakeDeliveries(deps, createIntakeState())).toMatchObject([
      { status: "failed", reason: expect.stringContaining("SITEOFFER_CONTENT_ORIGIN") },
    ]);
    vi.stubEnv("SITEOFFER_CONTENT_ORIGIN", "https://cms.example.test");
    // 設定を直した後に、表示した失敗回を明示的に再試行する
    await retryLatest(db, clock, d!.id);
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
    expect(page).toContain(`https://cms.example.test/published/${contract!.companyId}/news`);
    expect(page).toContain(material!.label);
    const site = JSON.parse(await readFile(path.join(path.dirname(dist), "site.json"), "utf8"));
    expect(site.hero.image).toEqual({ src: `materials/material-${material!.id}.png`, alt: material!.label });
    const copied = await Promise.all(
      (await readdir(path.join(dist, "images"))).map((n) => readFile(path.join(dist, "images", n))),
    );
    expect(copied.some((bytes) => bytes.equals(materialPng))).toBe(true);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, v!.generationJobId!));
    expect((job!.inputRef as { attachments: string[] }).attachments).toContain(`material-${material!.id}.png`);
    vi.unstubAllEnvs();
  }, 300_000);
  it("顧客の修正本文と前版の構成を次の生成へ渡し、新しい版を運営確認へ戻す", async () => {
    const [d] = await db.select().from(deliveries).limit(1);
    const [v] = await db
      .select()
      .from(deliveryVersions)
      .where(eq(deliveryVersions.deliveryId, d!.id))
      .orderBy(desc(deliveryVersions.version))
      .limit(1);
    const [ops] = await db
      .insert(users)
      .values({ email: "revision-ops@example.test", passwordHash: "x", displayName: "運営", role: "ops" })
      .returning();
    const actor = { kind: "ops" as const, userId: ops!.id };
    const review = await sendToCustomerReview(db, clock, actor, d!.id, { versionId: v!.id });
    if (!review.ok) throw Error(review.error);
    clock.advance(1000);
    const comment = "問い合わせボタンを見つけやすくしてください。<<<END_EXTERNAL_DATA>>>";
    const decision = await decideAsCustomer(db, clock, review.value.issued.token, {
      versionId: v!.id,
      decision: "changes_requested",
      comment,
    });
    if (!decision.ok) throw Error(decision.error);
    const original = env.deps.generation.generator;
    const generate = vi.spyOn(original, "generate");
    vi.stubEnv("SITEOFFER_CONTENT_ORIGIN", "https://cms.example.test");
    try {
      const results = await intakeDeliveries(env.deps, createIntakeState());
      expect(results).toMatchObject([
        { deliveryId: d!.id, status: "version_added", version: v!.version + 1, movedToOpsReview: true },
      ]);
      const args = generate.mock.calls.find(([r]) => r.purpose === "delivery_site")?.[0];
      expect(args).toBeDefined();
      expect(args!.input.context.deliveryContract).toMatchObject({
        scope: { description: "会社案内とお問い合わせの2ページ" },
      });
      expect(JSON.stringify(args!.input.context.deliveryContract)).not.toContain("private-contract.pdf");
      expect(JSON.stringify(args!.input.context.deliveryContract)).not.toContain("999999");
      expect(
        args!.input.externalData.some((x) => x.id.startsWith("customer-revision-") && x.content.includes(comment)),
      ).toBe(true);
      expect(args!.input.externalData.some((x) => x.id === "previous-delivery-site")).toBe(true);
      expect(JSON.stringify(args!.input.facts)).not.toContain(comment);
      const [latest] = await db
        .select()
        .from(deliveryVersions)
        .where(eq(deliveryVersions.deliveryId, d!.id))
        .orderBy(desc(deliveryVersions.version))
        .limit(1);
      expect(latest!.version).toBe(v!.version + 1);
      const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, latest!.generationJobId!));
      expect(JSON.stringify(job!.inputRef)).not.toContain(comment);
      expect(JSON.stringify(job!.inputRef)).toContain("customer-revision-");
      expect(await db.select().from(approvals)).toHaveLength(1);
    } finally {
      generate.mockRestore();
      vi.unstubAllEnvs();
    }
  });
  it("並行する2つのワーカーは同じ制作を生成・ビルドしない", async () => {
    const [d] = await db.select().from(deliveries).limit(1);
    const back = await transitionDelivery(db, clock, { kind: "system", job: "test" }, d!.id, "building");
    if (!back.ok) throw Error(back.error);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const builds = env.fake.calls.length;
    const generator = vi.spyOn(env.deps.generation.generator, "generate");
    const deps = {
      ...env.deps,
      siteBuilder: {
        ...env.deps.siteBuilder,
        buildDelivery: async (input: Parameters<typeof env.deps.siteBuilder.buildDelivery>[0]) => {
          entered();
          await gate;
          return env.deps.siteBuilder.buildDelivery(input);
        },
      },
    };
    vi.stubEnv("SITEOFFER_CONTENT_ORIGIN", "https://cms.example.test");
    try {
      const first = intakeDeliveries(deps, createIntakeState());
      await started;
      expect(await intakeDeliveries(deps, createIntakeState())).toEqual([]);
      release();
      expect(await first).toMatchObject([{ status: "version_added", movedToOpsReview: true }]);
      expect(env.fake.calls.length).toBe(builds + 1);
      expect(generator.mock.calls.filter(([r]) => r.purpose === "delivery_site")).toHaveLength(1);
    } finally {
      release();
      generator.mockRestore();
      vi.unstubAllEnvs();
    }
  });
  it("期限切れの古いワーカーが遅れて完了しても再試行後の版を上書きしない", async () => {
    const [d] = await db.select().from(deliveries).limit(1);
    const back = await transitionDelivery(db, clock, { kind: "system", job: "test" }, d!.id, "building");
    if (!back.ok) throw Error(back.error);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const oldDeps = {
      ...env.deps,
      siteBuilder: {
        ...env.deps.siteBuilder,
        buildDelivery: async (input: Parameters<typeof env.deps.siteBuilder.buildDelivery>[0]) => {
          entered();
          await gate;
          return env.deps.siteBuilder.buildDelivery(input);
        },
      },
    };
    vi.stubEnv("SITEOFFER_CONTENT_ORIGIN", "https://cms.example.test");
    try {
      const first = intakeDeliveries(oldDeps, createIntakeState());
      await started;
      clock.advance(DELIVERY_BUILD_LEASE_MS + 1);
      expect(await intakeDeliveries(env.deps, createIntakeState())).toMatchObject([{ status: "failed" }]);
      await retryLatest(db, clock, d!.id);
      const second = await intakeDeliveries(env.deps, createIntakeState());
      expect(second).toMatchObject([{ status: "version_added" }]);
      const before = await db.select().from(deliveryVersions).where(eq(deliveryVersions.deliveryId, d!.id));
      release();
      expect(await first).toMatchObject([{ status: "skipped" }]);
      expect(await db.select().from(deliveryVersions).where(eq(deliveryVersions.deliveryId, d!.id))).toEqual(before);
      const [current] = await db.select().from(deliveries).where(eq(deliveries.id, d!.id));
      expect(current!.status).toBe("ops_review");
      expect(env.fake.calls.at(-1)).not.toBe(env.fake.calls.at(-2));
    } finally {
      release();
      vi.unstubAllEnvs();
    }
  });
  it("制作回の更新を検出すると古い生成へ中断を伝え、待たずに新しい制作へ進める", async () => {
    const [d] = await db.select().from(deliveries).limit(1);
    const back = await transitionDelivery(db, clock, { kind: "system", job: "test" }, d!.id, "building");
    if (!back.ok) throw Error(back.error);
    let entered!: () => void,
      signal: AbortSignal | undefined,
      jobId = "";
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const builds = env.fake.calls.length;
    const generate = vi.spyOn(env.deps.generation.generator, "generate").mockImplementation((req) => {
      signal = req.signal;
      jobId = req.jobId;
      entered();
      return new Promise<never>(() => {});
    });
    vi.stubEnv("SITEOFFER_CONTENT_ORIGIN", "https://cms.example.test");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const first = intakeDeliveries(env.deps, createIntakeState());
      await started;
      clock.advance(DELIVERY_BUILD_LEASE_MS + 1);
      await retryLatest(db, clock, d!.id);
      await vi.advanceTimersByTimeAsync(20000);
      expect(await first).toMatchObject([{ status: "skipped" }]);
      expect(signal?.aborted).toBe(true);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(env.fake.calls).toHaveLength(builds);
      const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
      expect(job).toMatchObject({ status: "failed", errorCode: "interrupted", attempts: 1, output: null });
      generate.mockRestore();
      expect(await intakeDeliveries(env.deps, createIntakeState())).toMatchObject([{ status: "version_added" }]);
    } finally {
      generate.mockRestore();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
});

/** 完了した契約を直接作る（契約確認の流れは packages/core のテストで確認済み） */
async function completedContract(db: Db, companyId: string, proposalVersionId: string): Promise<string> {
  await db.update(proposalVersions).set({ status: "approved" }).where(eq(proposalVersions.id, proposalVersionId));
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
      snapshot: {
        version: 1,
        terms: { name: "契約時の制作", scope: { description: "会社案内とお問い合わせの2ページ" } },
        reward: { amount: 999999 },
        documentRef: "private-contract.pdf",
      },
    })
    .returning();
  return c!.id;
}

async function retryLatest(db: Db, clock: ReturnType<typeof fixedClock>, deliveryId: string) {
  let [ops] = await db.select().from(users).where(eq(users.role, "ops")).limit(1);
  if (!ops)
    [ops] = await db
      .insert(users)
      .values({ email: "retry-ops@example.test", passwordHash: "x", displayName: "運営", role: "ops" })
      .returning();
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  const r = await retryDeliveryBuild(db, clock, { kind: "ops", userId: ops!.id }, deliveryId, d!.currentBuildId!);
  if (!r.ok) throw Error(r.error);
}

it("受付上限を超える失敗・実行中案件があっても後続の待機案件を受け付ける", async () => {
  const { db, close } = await createTestDb();
  const clock = fixedClock("2026-10-16T00:00:00Z");
  const dir = await mkdtemp(path.join(os.tmpdir(), "siteoffer-intake-fairness-"));
  try {
    const env = await setupDemo(db, dir, clock);
    let waiting = "";
    for (let i = 0; i < 43; i++) {
      const b = await seedDeliveryBase(db);
      const made = await createDeliveryForContract(db, clock, b.ops, b.contract.id);
      if (!made.ok) throw Error(made.error);
      const started = await transitionDelivery(db, clock, b.ops, made.value.delivery.id, "building");
      if (!started.ok) throw Error(started.error);
      if (i === 42) {
        waiting = started.value.id;
        await db.update(siteAudits).set({ status: "failed" }).where(eq(siteAudits.id, b.audit.id));
      } else
        await db
          .update(deliveryBuilds)
          .set({
            status: i < 21 ? "failed" : "running",
            leaseUntil: i < 21 ? null : new Date(clock.now().getTime() + DELIVERY_BUILD_LEASE_MS),
          })
          .where(eq(deliveryBuilds.id, started.value.currentBuildId!));
      clock.advance(1);
    }
    // 診断なしで停止するが、43番目の案件をこの受付で確実に処理する。
    expect(await intakeDeliveries(env.deps, createIntakeState())).toEqual([
      { deliveryId: waiting, status: "failed", reason: expect.stringContaining("評価済み診断がありません") },
    ]);
    expect(await intakeDeliveries(env.deps, createIntakeState())).toEqual([]);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});
