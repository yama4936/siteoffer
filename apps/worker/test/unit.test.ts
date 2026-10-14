/** 設定・キュー登録・URL確認・生成の入力（DBを使わない、または軽いもの） */
import { companies, findings, siteAudits, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { generationInputSchema } from "@siteoffer/schemas";
import { describe, expect, it } from "vitest";
import { type BossLike, registerQueues } from "../src/boss.ts";
import { createGenerator, describeConfig, resolveWorkerConfig } from "../src/config.ts";
import { silentLogger } from "../src/deps.ts";
import { defaultGenerationInputBuilder } from "../src/input.ts";
import { foldStepEvents, STEP_ACTIONS } from "../src/ledger.ts";
import { DEFAULT_POLICIES, DEFAULT_SCHEDULES, QUEUES } from "../src/queues.ts";
import type { RunOutcome, WorkerRuntime } from "../src/runtime.ts";
import { checkPublicHttpUrl } from "../src/url.ts";

describe("設定", () => {
  it("既定はモック生成器・フィクスチャの取得元・取得済みの収集結果（外部へアクセスしない）", () => {
    const r = resolveWorkerConfig({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.generator).toEqual({ kind: "mock" });
    expect(r.value.discoveryProviders).toEqual(["fixture"]);
    expect(r.value.auditCollector.kind).toBe("fixture");
    expect(r.value.databaseUrl).toBeNull();
    expect(createGenerator(r.value.generator).kind).toBe("mock");
  });

  it("実Codexは必要な環境変数が揃ったときだけ選ぶ。揃わなければモックへ戻さず設定エラー", () => {
    expect(resolveWorkerConfig({ SITEOFFER_GENERATOR: "codex" })).toMatchObject({
      ok: false,
      error: "invalid_config",
    });
    const r = resolveWorkerConfig({
      SITEOFFER_GENERATOR: "codex",
      SITEOFFER_CODEX_IMAGE: "siteoffer-codex:dev",
      SITEOFFER_CODEX_NETWORK: "codex-egress",
      SITEOFFER_CODEX_AUTH_FILE: "/secure/auth.json",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.generator).toMatchObject({ kind: "codex", model: null });
    // 生成器を作るだけで、Codex・Dockerは呼ばない
    expect(createGenerator(r.value.generator, {}).kind).toBe("codex");
    // ログ用の要約に認証ファイルのパスや接続文字列を出さない
    expect(JSON.stringify(describeConfig(r.value))).not.toContain("/secure/auth.json");
  });

  it("国税庁APIはアプリケーションIDがあるときだけ有効にする", () => {
    expect(resolveWorkerConfig({ SITEOFFER_DISCOVERY_PROVIDERS: "fixture,nta" })).toMatchObject({ ok: false });
    const r = resolveWorkerConfig({ SITEOFFER_DISCOVERY_PROVIDERS: "fixture,nta", NTA_APPLICATION_ID: "dummy" });
    expect(r.ok && r.value.discoveryProviders).toEqual(["fixture", "nta"]);
    expect(resolveWorkerConfig({ SITEOFFER_DISCOVERY_PROVIDERS: "google" })).toMatchObject({ ok: false });
  });
});

describe("pg-boss への登録（pg-boss の代わりの記録用オブジェクト）", () => {
  function fakeBoss() {
    const queues: Record<string, unknown> = {};
    const handlers: Record<string, (jobs: { data: unknown }[]) => Promise<unknown>> = {};
    const schedules: Record<string, string> = {};
    const boss = {
      async createQueue(name: string, options?: unknown) {
        queues[name] = options;
      },
      async work(name: string, a: unknown, b?: unknown) {
        handlers[name] = (typeof a === "function" ? a : b) as (typeof handlers)[string];
        return name;
      },
      async schedule(name: string, cron: string) {
        schedules[name] = cron;
      },
      async send() {
        return null;
      },
    } as unknown as BossLike;
    return { boss, queues, handlers, schedules };
  }

  it("処理のキューは exclusive・再試行上限・制限時間付きで作り、retry の結果は例外にして再試行させる", async () => {
    const f = fakeBoss();
    let next: RunOutcome = { status: "retry", key: "k", attempt: 1, reason: "一時的な失敗" };
    const runtime: WorkerRuntime = { run: async () => next };
    await registerQueues(
      f.boss,
      runtime,
      {
        policies: DEFAULT_POLICIES,
        schedules: { ...DEFAULT_SCHEDULES },
        concurrency: { discovery: 1, audit: 2, proposal: 2 },
      },
      silentLogger,
    );
    expect(f.queues[QUEUES.proposal]).toMatchObject({
      policy: "exclusive",
      retryLimit: DEFAULT_POLICIES.proposal.maxAttempts - 1,
      expireInSeconds: DEFAULT_POLICIES.proposal.timeoutMs / 1000 + 60,
    });
    expect(f.schedules).toEqual({
      [QUEUES.expireAssignments]: DEFAULT_SCHEDULES.expireAssignments,
      [QUEUES.recoverDiscovery]: DEFAULT_SCHEDULES.recoverDiscovery,
    });

    const handler = f.handlers[QUEUES.proposal]!;
    await expect(handler([{ data: {} }])).rejects.toThrow("一時的な失敗");
    next = { status: "failed", key: "k", attempt: 3, reason: "上限" };
    await expect(handler([{ data: {} }])).resolves.toBeUndefined();
    next = { status: "duplicate", key: "k", state: "succeeded", attempts: 1 };
    await expect(handler([{ data: {} }])).resolves.toBeUndefined();
  });
});

describe("実行台帳の集計", () => {
  it("開始・終了の記録から、試行回数・実行中・上限到達を導く", () => {
    const t = new Date("2026-10-14T00:00:00Z");
    const ev = (action: string, after: object) => ({ action, after, createdAt: t });
    expect(foldStepEvents([ev(STEP_ACTIONS.started, { attempt: 1 })])).toMatchObject({ attempts: 1, running: true });
    expect(
      foldStepEvents([
        ev(STEP_ACTIONS.started, { attempt: 1 }),
        ev(STEP_ACTIONS.failed, { attempt: 1, reason: "a", final: false }),
        ev(STEP_ACTIONS.started, { attempt: 2 }),
        ev(STEP_ACTIONS.failed, { attempt: 2, reason: "b", final: true }),
      ]),
    ).toMatchObject({ attempts: 2, running: false, gaveUp: true, lastFailure: "b" });
  });
});

describe("診断に送るURL（19章）", () => {
  it.each([
    ["https://www.aoba-print.test/", true],
    ["http://example.co.jp/path", true],
    ["ftp://example.com/", false],
    ["http://localhost/", false],
    ["http://127.0.0.1/", false],
    ["http://169.254.169.254/latest/meta-data/", false],
    ["http://10.0.0.1/", false],
    ["http://192.168.1.10/", false],
    ["http://[::1]/", false],
    ["http://[::ffff:127.0.0.1]/", false],
    ["http://user:pw@example.com/", false],
    ["http://example.com:8080/", false],
    ["http://intranet/", false],
    ["http://metadata.google.internal/", false],
  ])("%s → %s", (url, expected) => {
    expect(checkPublicHttpUrl(url).ok).toBe(expected);
  });
});

describe("生成の入力（既定）", () => {
  it("出典のある企業名・所在地だけを確認済みにし、電話・業種は要確認。診断の観測は外部データに入れる", async () => {
    const { db, close } = await createTestDb();
    try {
      const [c] = await db
        .insert(companies)
        .values({
          name: "株式会社架空印刷",
          address: "愛知県名古屋市中村区1-2-3",
          addressSourceUrl: "https://example.test/source",
          representativePhone: "000-0000-0000",
          industry: "印刷業",
        })
        .returning();
      const [w] = await db
        .insert(websites)
        .values({
          companyId: c!.id,
          url: "https://kakuu.test/",
          normalizedUrl: "https://kakuu.test/",
          domain: "kakuu.test",
        })
        .returning();
      const [a] = await db
        .insert(siteAudits)
        .values({ companyId: c!.id, websiteId: w!.id, targetUrl: "https://kakuu.test/", status: "evaluated" })
        .returning();
      await db.insert(findings).values([
        {
          auditId: a!.id,
          itemCode: "A1",
          category: "A",
          status: "scored",
          score: 0,
          observations: ["https://kakuu.test/ ヘッダー"],
        },
        {
          auditId: a!.id,
          itemCode: "B1",
          category: "B",
          status: "scored",
          score: 3,
          observations: ["https://kakuu.test/"],
        },
      ]);
      const input = await defaultGenerationInputBuilder(db, { company: c!, audit: a! });
      expect(generationInputSchema.safeParse(input).success).toBe(true);
      expect(Object.fromEntries(input.facts.map((f) => [f.key, f.status]))).toEqual({
        "company.name": "confirmed",
        "company.address": "confirmed",
        "company.phone": "needs_review",
        "company.industry": "needs_review",
      });
      expect(input.externalData[0]!.content).toContain("ヘッダー");
      expect(input.context.evaluationItemIds).toEqual(["A1"]);
    } finally {
      await close();
    }
  });
});
