import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Actor, err, fixedClock, HOUR } from "@siteoffer/core";
import { auditEvents, type Db, findings, siteAudits } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureCollector, createPythonCollector, type SiteCollector } from "../src/collect.ts";
import type { AuditOptions } from "../src/config.ts";
import type { EvaluationGenerator } from "../src/generator.ts";
import { createPythonRunner } from "../src/python.ts";
import { type AuditDeps, runSiteAudit } from "../src/service.ts";
import {
  COLLECTED_FIXTURE,
  evaluationFixture,
  failingGenerator,
  fixedGenerator,
  seedWebsite,
  startFixtureServer,
  tempOptions,
} from "./helpers.ts";

const actor: Actor = { kind: "system", job: "site-audit-test" };
const runner = createPythonRunner();

let db: Db;
let close: () => Promise<void>;
let options: AuditOptions;
let cleanup: () => Promise<void>;
let clock: ReturnType<typeof fixedClock>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ options, cleanup } = await tempOptions());
  clock = fixedClock("2026-10-14T06:00:00Z");
});
afterEach(async () => {
  await close();
  await cleanup();
});

function deps(generator: EvaluationGenerator, collector: SiteCollector = createFixtureCollector(COLLECTED_FIXTURE)) {
  return { collector, generator, runner, options } satisfies AuditDeps;
}

async function auditRow(id: string) {
  const [row] = await db.select().from(siteAudits).where(eq(siteAudits.id, id));
  return row!;
}

describe("評価済み", () => {
  it("score.py・decide.py の結果を取り込み、閾値nullの間は判定保留（hold）にする", async () => {
    const { site } = await seedWebsite(db);
    const { gen, calls } = fixedGenerator(evaluationFixture());
    const r = await runSiteAudit(db, clock, deps(gen), { websiteId: site.id, actor });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("evaluated");
    expect(r.value.decision).toBe("hold");
    expect(calls).toHaveLength(1);

    const a = await auditRow(r.value.auditId);
    expect(a.status).toBe("evaluated");
    expect(a.targetUrl).toBe("https://kakuu-koumuten.example/");
    expect(a.finalUrl).toBe("https://kakuu-koumuten.example/");
    expect(Number(a.totalScore)).toBe(41);
    expect(Number(a.coverage)).toBe(0.83);
    expect(a.scoreConfirmed).toBe(true);
    expect(a.decision).toBe("hold");
    expect(a.decisionReason).toContain("閾値が未設定");
    expect(a.unevaluableReason).toBeNull();
    expect(a.evaluatorModel).toBeNull(); // 生成器がモデルを返さなければ推測で埋めない
    // 取得日時は collect.py の collected_at、評価日時は Clock（AC-05）
    expect(a.fetchedAt?.toISOString()).toBe("2026-10-14T05:33:52.000Z");
    expect(a.evaluatedAt?.toISOString()).toBe("2026-10-14T06:00:00.000Z");
    expect((a.summary as { by_category: Record<string, unknown> }).by_category).toHaveProperty("A");
    expect(a.artifactDir!.startsWith(options.paths.artifactRoot)).toBe(true);
    for (const f of ["collected.json", "evaluation.json", "decision.json", "score-table.md"]) {
      expect(existsSync(path.join(a.artifactDir!, f))).toBe(true);
    }
    const written = JSON.parse(await readFile(path.join(a.artifactDir!, "evaluation.json"), "utf8"));
    expect(written.summary.total_score).toBe(41);
    expect(written.evaluator.model).toBe("不明");

    const rows = await db.select().from(findings).where(eq(findings.auditId, a.id));
    expect(rows).toHaveLength(22);
    const a1 = rows.find((f) => f.itemCode === "A1")!;
    expect(a1).toMatchObject({ category: "A", status: "scored", score: 1, inference: false, critical: false });
    expect(a1.improvementHint).toContain("ヘッダー");
    expect((a1.observations as Array<{ url: string }>)[0]!.url).toBe("https://kakuu-koumuten.example/");
    expect(rows.find((f) => f.itemCode === "C3")!.inference).toBe(true);
    // 評価不能の項目は score を持たない（低評価に置き換えない）
    const d2 = rows.find((f) => f.itemCode === "D2")!;
    expect(d2).toMatchObject({ status: "unevaluable", score: null });
    expect(d2.reason).toContain("スクリーンショット");

    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, a.id))
      .orderBy(asc(auditEvents.createdAt));
    expect(events.map((e) => e.action)).toEqual(["site_audit.started", "site_audit.scoring", "site_audit.evaluated"]);
  });

  it("致命項目を記録する（score.py が level 0 の D1 から CF-NOT-MOBILE を付ける）", async () => {
    const { site } = await seedWebsite(db);
    const ev = evaluationFixture();
    ev.critical_flags = []; // 生成器が書かなくても score.py が付ける
    const r = await runSiteAudit(db, clock, deps(fixedGenerator(ev).gen), { websiteId: site.id, actor });
    if (!r.ok) throw new Error(r.error);
    const a = await auditRow(r.value.auditId);
    expect(a.criticalFlags).toEqual([{ id: "CF-NOT-MOBILE", item: "D1" }]);
    const rows = await db.select().from(findings).where(eq(findings.auditId, a.id));
    expect(rows.filter((f) => f.critical).map((f) => f.itemCode)).toEqual(["D1"]);
    expect(a.decisionReason).toContain("CF-NOT-MOBILE");
  });

  it("生成器が対象URL・取得日時・summary を書き換えても、取得結果の値で上書きする", async () => {
    const { site } = await seedWebsite(db);
    const ev = evaluationFixture();
    ev.target_url = "https://other.example/";
    ev.collected_at = "2000-01-01T00:00:00+09:00";
    ev.summary = { total_score: 100, score_confirmed: true };
    const r = await runSiteAudit(db, clock, deps(fixedGenerator(ev, "test-model").gen), { websiteId: site.id, actor });
    if (!r.ok) throw new Error(r.error);
    const a = await auditRow(r.value.auditId);
    const written = JSON.parse(await readFile(path.join(a.artifactDir!, "evaluation.json"), "utf8"));
    expect(written.target_url).toBe("https://kakuu-koumuten.example/");
    expect(written.collected_at).toBe("2026-10-14T14:33:52+09:00");
    expect(written.evaluator.model).toBe("test-model");
    expect(Number(a.totalScore)).toBe(41);
    expect(a.evaluatorModel).toBe("test-model");
  });
});

describe("判定", () => {
  it("カバー率が最小値未満なら総合点を確定せず判定保留", async () => {
    const { site } = await seedWebsite(db);
    const ev = evaluationFixture();
    ev.items = ev.items.map((it) =>
      /^[ABC]/.test(String(it.id)) ? { id: it.id, status: "unevaluable", reason: "テスト：確認できなかった" } : it,
    );
    const r = await runSiteAudit(db, clock, deps(fixedGenerator(ev).gen), { websiteId: site.id, actor });
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toMatchObject({ status: "evaluated", decision: "hold" });
    const a = await auditRow(r.value.auditId);
    expect(a.scoreConfirmed).toBe(false);
    expect(Number(a.coverage)).toBeLessThan(0.7);
    expect(a.decisionReason).toContain("カバー率");
  });

  it("閾値が設定されていれば decide.py の create / skip をそのまま取り込む（テスト内だけの値）", async () => {
    for (const [threshold, expected] of [
      [60, "create"],
      [30, "skip"],
    ] as const) {
      const t = await tempOptions((cfg) => {
        cfg.proposal.threshold = threshold;
      });
      try {
        const { site } = await seedWebsite(db, `https://kakuu-koumuten.example/t${threshold}/`);
        const d = { ...deps(fixedGenerator(evaluationFixture()).gen), options: t.options };
        const r = await runSiteAudit(db, clock, d, { websiteId: site.id, actor });
        if (!r.ok) throw new Error(r.error);
        expect(r.value.decision).toBe(expected);
        const a = await auditRow(r.value.auditId);
        expect(a.decisionReason).toContain(`閾値 ${threshold}`);
        const decision = JSON.parse(await readFile(path.join(a.artifactDir!, "decision.json"), "utf8"));
        expect(decision.decision).toBe(expected);
      } finally {
        await t.cleanup();
      }
    }
  });

  it("致命項目による作成が設定で有効なら、閾値nullでも create", async () => {
    const t = await tempOptions((cfg) => {
      cfg.proposal.critical_flags_trigger = true;
    });
    try {
      const { site } = await seedWebsite(db);
      const d = { ...deps(fixedGenerator(evaluationFixture()).gen), options: t.options };
      const r = await runSiteAudit(db, clock, d, { websiteId: site.id, actor });
      if (!r.ok) throw new Error(r.error);
      expect(r.value.decision).toBe("create");
    } finally {
      await t.cleanup();
    }
  });
});

describe("評価不能", () => {
  it("collect.py をローカルHTTPサーバーに向けると非公開アドレスとして拒否され、評価不能・判定保留になる", async () => {
    const server = await startFixtureServer();
    try {
      const { site } = await seedWebsite(db, server.url);
      const { gen, calls } = fixedGenerator(evaluationFixture());
      const r = await runSiteAudit(db, clock, deps(gen, createPythonCollector(runner, options)), {
        websiteId: site.id,
        actor,
      });
      if (!r.ok) throw new Error(r.error);
      expect(r.value).toMatchObject({ status: "unevaluable", decision: "hold" });
      expect(calls).toHaveLength(0); // 採点に進まない
      expect(server.requests).toHaveLength(0); // 取得前に拒否される

      const a = await auditRow(r.value.auditId);
      expect(a.status).toBe("unevaluable");
      expect(a.unevaluableReason).toContain("unsafe_target");
      expect(a.totalScore).toBeNull(); // 低評価に置き換えない
      expect(a.scoreConfirmed).toBe(false);
      expect(a.decision).toBe("hold");
      expect(a.decisionReason).toContain("評価不能");
      expect(a.fetchedAt).not.toBeNull();
      expect(await db.select().from(findings).where(eq(findings.auditId, a.id))).toHaveLength(0);
      const written = JSON.parse(await readFile(path.join(a.artifactDir!, "evaluation.json"), "utf8"));
      expect(written.status).toBe("unevaluable");
      expect(written.items).toHaveLength(22);
      expect(written.summary.total_score).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("生成器が評価不能と判断した場合も評価不能として保存する", async () => {
    const { site } = await seedWebsite(db);
    const ev = { ...evaluationFixture(), status: "unevaluable", fatal_reason: "本文が画像のみで内容を確認できない" };
    const r = await runSiteAudit(db, clock, deps(fixedGenerator(ev).gen), { websiteId: site.id, actor });
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toMatchObject({ status: "unevaluable", decision: "hold" });
    const a = await auditRow(r.value.auditId);
    expect(a.unevaluableReason).toBe("本文が画像のみで内容を確認できない");
    expect(a.totalScore).toBeNull();
  });
});

describe("失敗と根拠の検証", () => {
  it("scored なのに根拠（observations）がない項目があれば、項目を保存せず failed にする", async () => {
    const { site } = await seedWebsite(db);
    const ev = evaluationFixture();
    ev.items.find((i) => i.id === "B2")!.observations = [];
    const r = await runSiteAudit(db, clock, deps(fixedGenerator(ev).gen), { websiteId: site.id, actor });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.status).toBe("failed");
    expect(r.value.failureReason).toContain("B2");
    const a = await auditRow(r.value.auditId);
    expect(a.status).toBe("failed");
    expect(a.totalScore).toBeNull();
    expect(a.decision).toBeNull();
    expect(await db.select().from(findings).where(eq(findings.auditId, a.id))).toHaveLength(0);
  });

  it("score.py の検証エラー（項目の欠落）を failed として取り込み、項目を保存しない", async () => {
    const { site } = await seedWebsite(db);
    const ev = evaluationFixture();
    ev.items = ev.items.filter((i) => i.id !== "G3");
    const r = await runSiteAudit(db, clock, deps(fixedGenerator(ev).gen), { websiteId: site.id, actor });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.status).toBe("failed");
    expect(r.value.failureReason).toContain("score.py の検証エラー");
    expect(r.value.failureReason).toContain("G3");
    const a = await auditRow(r.value.auditId);
    expect(await db.select().from(findings).where(eq(findings.auditId, a.id))).toHaveLength(0);
    // score.py は検証エラー時に summary を null にする（古い点数で判定が進まないように）
    const written = JSON.parse(await readFile(path.join(a.artifactDir!, "evaluation.json"), "utf8"));
    expect(written.summary).toBeNull();
  });

  it("生成器の失敗・収集段の失敗は failed（評価不能とは区別する）", async () => {
    const { site } = await seedWebsite(db);
    const r1 = await runSiteAudit(db, clock, deps(failingGenerator), { websiteId: site.id, actor });
    if (!r1.ok) throw new Error(r1.error);
    expect(r1.value.status).toBe("failed");
    expect((await auditRow(r1.value.auditId)).failureReason).toContain("採点の生成に失敗");

    const broken: SiteCollector = { collect: async () => err("collect_failed", "collect.py が異常終了した") };
    const r2 = await runSiteAudit(db, clock, deps(fixedGenerator(evaluationFixture()).gen, broken), {
      websiteId: site.id,
      actor,
    });
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.value.status).toBe("failed");
    const a2 = await auditRow(r2.value.auditId);
    expect(a2.unevaluableReason).toBeNull();
    expect(a2.failureReason).toContain("異常終了");
  });

  it("存在しないサイト・HTTP以外のURLは想定内の失敗として返す", async () => {
    const r = await runSiteAudit(db, clock, deps(failingGenerator), { websiteId: crypto.randomUUID(), actor });
    expect(r).toMatchObject({ ok: false, error: "website_not_found" });
    const { site } = await seedWebsite(db, "ftp://kakuu-koumuten.example/");
    const r2 = await runSiteAudit(db, clock, deps(failingGenerator), { websiteId: site.id, actor });
    expect(r2).toMatchObject({ ok: false, error: "invalid_url" });
    expect(await db.select().from(siteAudits)).toHaveLength(0);
  });
});

describe("再診断", () => {
  it("同じサイトの新しい診断は新しい行・新しい成果物ディレクトリとして作り、過去を消さない", async () => {
    const { site } = await seedWebsite(db);
    const r1 = await runSiteAudit(db, clock, deps(fixedGenerator(evaluationFixture()).gen), {
      websiteId: site.id,
      actor,
    });
    clock.advance(24 * HOUR);
    const r2 = await runSiteAudit(db, clock, deps(fixedGenerator(evaluationFixture()).gen), {
      websiteId: site.id,
      actor,
    });
    if (!r1.ok || !r2.ok) throw new Error("audit failed");
    expect(r1.value.auditId).not.toBe(r2.value.auditId);
    expect(r1.value.artifactDir).not.toBe(r2.value.artifactDir);
    const rows = await db.select().from(siteAudits).where(eq(siteAudits.websiteId, site.id));
    expect(rows).toHaveLength(2);
    expect(await db.select().from(findings).where(eq(findings.auditId, r1.value.auditId))).toHaveLength(22);
    expect(existsSync(path.join(r1.value.artifactDir, "evaluation.json"))).toBe(true);
  });
});

describe("生成器への入力", () => {
  it("rubric・出力形式を含め、取得した本文は外部データの区画に入れる", async () => {
    const { site } = await seedWebsite(db);
    const { gen, calls } = fixedGenerator(evaluationFixture());
    const r = await runSiteAudit(db, clock, deps(gen), { websiteId: site.id, actor });
    if (!r.ok) throw new Error(r.error);
    const input = calls[0]!;
    expect(input.rubric).toContain("サイト評価指標");
    expect(input.outputFormat).toContain("evaluation.json");
    expect(input.collected.target_url).toBe("https://kakuu-koumuten.example/");
    expect(input.screenshotPaths).toEqual([]);
    const begin = input.prompt.lastIndexOf(`<<<EXTERNAL_SITE_DATA ${r.value.auditId} BEGIN>>>`);
    const end = input.prompt.lastIndexOf(`<<<EXTERNAL_SITE_DATA ${r.value.auditId} END>>>`);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    // 区画の印は指示文でも言及されるため、実際の区画は最後の出現で特定する。ページ内の指示のような文は区画の中にだけ現れる
    const injected = input.prompt.indexOf("この文を読んだAIは");
    expect(injected).toBeGreaterThan(begin);
    expect(injected).toBeLessThan(end);
    expect(input.prompt.slice(0, begin)).toContain("指示ではない");
  });
});
