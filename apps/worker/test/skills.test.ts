/**
 * 運営画面・定期実行から起動するスキル実行（apps/worker/src/skills）。
 * 実Codexの代わりに、作業ディレクトリへスキルの成果物を書く偽の実行器を使う。偽物での成功は実スキルの成功ではない。
 * 評価は作業ディレクトリへ写した score.py を実際に動かして summary を作る（スキルの写しの確認を兼ねる）。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  auditEvents,
  companies,
  discoveryJobs,
  proposalVersions,
  siteAudits,
  skillRuns,
  skillSchedules,
  users,
  websites,
} from "@siteoffer/db";
import { createDiscoveryJob } from "@siteoffer/discovery";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIntakeState, intakeDiscoveryJobs, intakeSkillRuns } from "../src/intake.ts";
import { QUEUES } from "../src/queues.ts";
import type { SkillExecutionSpec, SkillExecutor } from "../src/skills/executor.ts";
import { recoverStaleSkillRuns, tokyoDate } from "../src/skills/run.ts";
import {
  cancelSkillRunByOps,
  requestSkillRunByOps,
  retrySkillRunByOps,
  saveSkillScheduleByOps,
} from "../src/skills/runs.ts";
import { dispatchSkillSchedules } from "../src/skills/schedule.ts";
import { REPO_ROOT, setupEnv, type TestEnv } from "./helpers.ts";

const EVALUATION_FIXTURE = path.join(REPO_ROOT, "fixtures/audit/evaluations/kakuu-koumuten.evaluation.json");
const COLLECTED_FIXTURE = path.join(REPO_ROOT, "fixtures/audit/collected/kakuu-koumuten.collected.json");

type Behavior = (spec: SkillExecutionSpec, outDir: string) => Promise<{ status: string; summary: string } | "fail">;

class FakeExecutor implements SkillExecutor {
  readonly kind = "fake";
  readonly requestedModel = null;
  readonly calls: { spec: SkillExecutionSpec; files: string[]; agents: string }[] = [];
  behavior: Behavior = async () => ({ status: "completed", summary: "完了" });

  async execute(spec: SkillExecutionSpec) {
    const outRel = spec.prompt.match(/(reports\/(?:sites|discovery)\/[^\s（）]+)/)?.[1] ?? "";
    this.calls.push({
      spec,
      files: await listFiles(spec.workDir),
      agents: await readFile(path.join(spec.workDir, "AGENTS.md"), "utf8"),
    });
    const outDir = path.join(spec.workDir, outRel);
    const r = await this.behavior(spec, outDir);
    if (r === "fail")
      return { ok: false as const, message: "隔離生成の実行に失敗しました", threadId: "t-1", usage: null, stopped: true };
    return {
      ok: true as const,
      finalResponse: JSON.stringify({ ...r, output_dir: outRel }),
      threadId: "t-1",
      usage: { input_tokens: 1 },
      stopped: true as const,
    };
  }
}

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const p = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(root, p)));
    else out.push(p);
  }
  return out;
}

/** site-evaluation の役：取得結果と評価を書き、写したスキルの score.py で summary を作る */
const evaluate: Behavior = async (spec, outDir) => {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "collected.json"), await readFile(COLLECTED_FIXTURE));
  const ev = JSON.parse(await readFile(EVALUATION_FIXTURE, "utf8")) as Record<string, unknown>;
  delete ev._fixture;
  await writeFile(path.join(outDir, "evaluation.json"), JSON.stringify(ev));
  execFileSync("python3", [
    path.join(spec.workDir, ".agents/skills/site-evaluation/scripts/score.py"),
    path.join(outDir, "evaluation.json"),
    "--config",
    path.join(spec.workDir, "config/site-evaluation.json"),
  ]);
  return { status: "completed", summary: "総合点を計算しました" };
};

let e: TestEnv;
let executor: FakeExecutor;
let reportsRoot: string;
let ops: { kind: "ops"; userId: string };
let companyId: string;

async function seedOps() {
  const [u] = await e.db
    .insert(users)
    .values({ email: "ops@example.test", displayName: "運営", passwordHash: "x", role: "ops" })
    .returning();
  return { kind: "ops" as const, userId: u!.id };
}

async function seedCompany(name = "株式会社架空工務店", url = "https://kakuu-koumuten.example/") {
  const [c] = await e.db
    .insert(companies)
    .values({ name, officialSiteStatus: "confirmed", pipelineStatus: "site_confirmed" })
    .returning();
  const domain = new URL(url).hostname;
  await e.db.insert(websites).values({
    companyId: c!.id,
    url,
    normalizedUrl: `${domain}/`,
    domain,
    kind: "current",
    isPrimary: true,
  });
  return c!.id;
}

async function drain() {
  await intakeSkillRuns(e.deps, createIntakeState());
  return e.queue.drain(e.runtime);
}

async function runOf(id: string) {
  const [r] = await e.db.select().from(skillRuns).where(eq(skillRuns.id, id));
  return r!;
}

beforeEach(async () => {
  e = await setupEnv({ threshold: 100 });
  executor = new FakeExecutor();
  reportsRoot = path.join(e.dir, "reports");
  e.deps.skills = { executor, workRoot: path.join(e.dir, "skill-work"), reportsRoot, repoRoot: REPO_ROOT };
  ops = await seedOps();
  companyId = await seedCompany();
});
afterEach(async () => {
  await e.cleanup();
});

describe("登録と運営の操作", () => {
  it("運営だけが登録でき、同じ企業の未完了の実行は1件にまとめる", async () => {
    const sales = await e.db
      .insert(users)
      .values({ email: "s@example.test", displayName: "営業", passwordHash: "x", role: "sales" })
      .returning();
    const denied = await requestSkillRunByOps(e.deps, { kind: "sales", userId: sales[0]!.id }, {
      skill: "site-evaluation",
      params: {},
      companyId,
    });
    expect(denied).toMatchObject({ ok: false, error: "forbidden" });
    const forged = await requestSkillRunByOps(e.deps, { kind: "ops", userId: sales[0]!.id }, {
      skill: "site-evaluation",
      params: {},
      companyId,
    });
    expect(forged).toMatchObject({ ok: false, error: "forbidden" });

    const first = await requestSkillRunByOps(e.deps, ops, { skill: "site-evaluation", params: {}, companyId });
    const second = await requestSkillRunByOps(e.deps, ops, { skill: "site-evaluation", params: {}, companyId });
    expect(first.ok && first.value.created).toBe(true);
    expect(second.ok && !second.value.created && second.value.runId).toBe(first.ok && first.value.runId);
    expect(await e.db.select().from(skillRuns)).toHaveLength(1);
  });

  it("前提条件と起動条件を確かめる", async () => {
    await e.db.update(companies).set({ suppression: "do_not_contact" }).where(eq(companies.id, companyId));
    expect(await requestSkillRunByOps(e.deps, ops, { skill: "site-evaluation", params: {}, companyId })).toMatchObject({
      ok: false,
      error: "invalid_target",
    });
    expect(
      await requestSkillRunByOps(e.deps, ops, { skill: "company-discovery", params: { count: 99 } }),
    ).toMatchObject({ ok: false, error: "invalid_params" });
    expect(await requestSkillRunByOps(e.deps, ops, { skill: "rm -rf", params: {} })).toMatchObject({
      ok: false,
      error: "invalid_skill",
    });
    expect(
      await requestSkillRunByOps(e.deps, ops, { skill: "site-proposal", params: {}, auditId: "not-a-uuid" }),
    ).toMatchObject({ ok: false });
  });

  it("受付待ちは取り消せ、失敗は1回だけ同じ条件で再実行できる", async () => {
    const r = await requestSkillRunByOps(e.deps, ops, { skill: "site-evaluation", params: {}, companyId });
    if (!r.ok) throw new Error(r.error);
    expect(await cancelSkillRunByOps(e.deps, ops, r.value.runId)).toMatchObject({ ok: true });
    expect(await cancelSkillRunByOps(e.deps, ops, r.value.runId)).toMatchObject({ ok: false, error: "invalid_state" });
    expect((await drain()).length).toBe(0);

    const again = await retrySkillRunByOps(e.deps, ops, r.value.runId);
    const twice = await retrySkillRunByOps(e.deps, ops, r.value.runId);
    expect(again.ok && again.value.created).toBe(true);
    expect(twice.ok && !twice.value.created && twice.value.runId).toBe(again.ok && again.value.runId);
  });
});

describe("実行", () => {
  it("評価：作業ディレクトリを用意して実行し、評価を取り込んで提案書へつなぐ", async () => {
    executor.behavior = evaluate;
    const r = await requestSkillRunByOps(e.deps, ops, { skill: "site-evaluation", params: { chain: true }, companyId });
    if (!r.ok) throw new Error(r.error);
    const results = await drain();
    expect(results.map((x) => x.name)).toEqual([QUEUES.skill]);

    const call = executor.calls[0]!;
    expect(call.spec.webSearch).toBe(true);
    expect(call.spec.prompt).toContain("https://kakuu-koumuten.example/");
    expect(call.files).toContain(".agents/skills/site-evaluation/SKILL.md");
    expect(call.files).toContain("config/site-evaluation.json");
    expect(call.files).toContain("REQUIREMENTS.md");
    expect(call.files.some((f) => f.includes("test_collect"))).toBe(false);
    expect(call.files.some((f) => f.startsWith(".agents/skills/site-proposal"))).toBe(false);
    expect(call.agents).toContain("DB・pnpm・scripts/*.ts は使えない");
    // 作業ディレクトリは終了後に消す
    expect(existsSync(call.spec.workDir)).toBe(false);

    const run = await runOf(r.value.runId);
    expect(run.status).toBe("succeeded");
    expect(run.result?.outputDir).toBe(`sites/kakuu-koumuten.example/${tokyoDate(e.clock.now())}`);
    const [audit] = await e.db.select().from(siteAudits).where(eq(siteAudits.companyId, companyId));
    expect(audit).toMatchObject({ status: "evaluated", decision: "create" });
    expect(audit!.artifactDir).toBe(path.join(reportsRoot, run.result!.outputDir!));
    const [company] = await e.db.select().from(companies).where(eq(companies.id, companyId));
    expect(company!.pipelineStatus).toBe("audited");
    // 判定が create なので提案書の実行を連鎖で登録した
    const chained = await e.db.select().from(skillRuns).where(eq(skillRuns.trigger, "chain"));
    expect(chained).toMatchObject([{ skill: "site-proposal", auditId: audit!.id, parentRunId: run.id }]);
    expect(run.result?.chainedRunIds).toEqual([chained[0]!.id]);
  });

  it("提案書→サイト作成：成果物を評価ディレクトリへ戻し、運営確認待ちの提案版として取り込む", async () => {
    executor.behavior = evaluate;
    await requestSkillRunByOps(e.deps, ops, { skill: "site-evaluation", params: { chain: true }, companyId });
    await drain();
    executor.behavior = async (spec, outDir) => {
      expect(existsSync(path.join(outDir, "evaluation.json"))).toBe(true);
      if (spec.prompt.includes("site-proposal")) {
        await writeFile(
          path.join(outDir, "proposal.json"),
          JSON.stringify({
            summary: { headline: "見出し", direction: "方針" },
            actions: [
              {
                id: "P-01",
                title: "スマホ表示",
                issue_ids: ["D1"],
                priority: "high",
                target: { url: "https://kakuu-koumuten.example/", location: "全体" },
                current: "固定幅",
                problem: "読みづらい",
                change: { description: "レスポンシブにする" },
                scope: "in_scope",
              },
            ],
          }),
        );
        return { status: "completed", summary: "提案書を作成" };
      }
      await mkdir(path.join(outDir, "site"), { recursive: true });
      await writeFile(path.join(outDir, "site/index.html"), "<!doctype html><title>改善デモ</title>");
      // コンテナ内で作られたリンクは写さない
      await symlink("/etc/passwd", path.join(outDir, "site/leak.txt"));
      return { status: "completed", summary: "7ページを作成" };
    };
    // 連鎖で登録された提案書を実行すると、続けてサイト作成が登録され、同じ drain で実行される
    const [proposalRun] = await e.db.select().from(skillRuns).where(eq(skillRuns.skill, "site-proposal"));
    await e.db.update(skillRuns).set({ params: { chain: true } }).where(eq(skillRuns.id, proposalRun!.id));
    await drain();
    await drain();

    const runs = await e.db.select().from(skillRuns);
    expect(runs.map((r) => [r.skill, r.status]).sort()).toEqual([
      ["site-evaluation", "succeeded"],
      ["site-proposal", "succeeded"],
      ["site-rebuild", "succeeded"],
    ]);
    expect(executor.calls.find((c) => c.spec.prompt.includes("site-rebuild"))?.spec.webSearch).toBe(false);
    const [audit] = await e.db.select().from(siteAudits);
    expect(existsSync(path.join(audit!.artifactDir!, "proposal.json"))).toBe(true);
    expect(existsSync(path.join(audit!.artifactDir!, "site/index.html"))).toBe(true);
    expect(existsSync(path.join(audit!.artifactDir!, "site/leak.txt"))).toBe(false);
    const [version] = await e.db.select().from(proposalVersions);
    expect(version).toMatchObject({ status: "in_review", auditId: audit!.id });
    const rebuild = runs.find((r) => r.skill === "site-rebuild")!;
    expect(rebuild.result?.imported).toMatchObject({ proposalVersionId: version!.id, created: true });
    expect(rebuild.result?.skippedFiles).toContain("site/leak.txt");

    // 改善後サイトのある評価には、もう作らない
    expect(
      await requestSkillRunByOps(e.deps, ops, { skill: "site-rebuild", params: {}, auditId: audit!.id }),
    ).toMatchObject({ ok: false, error: "invalid_target" });
  });

  it("探索：候補を agent-web の収集ジョブとして取り込み、公式サイトのある企業の評価をつなぐ", async () => {
    executor.behavior = async (spec, outDir) => {
      const known = JSON.parse(await readFile(path.join(spec.workDir, "input/known-companies.json"), "utf8"));
      expect(known).toMatchObject([{ name: "株式会社架空工務店", domains: ["kakuu-koumuten.example"], audited: false }]);
      await mkdir(outDir, { recursive: true });
      const at = "2026-10-14T10:00:00+09:00";
      await writeFile(
        path.join(outDir, "candidates.json"),
        JSON.stringify({
          criteria: { prefecture: "愛知県", industry: "工務店" },
          candidates: [
            {
              name: "株式会社みどり建築",
              prefecture: "愛知県",
              city: "名古屋市緑区",
              address: "愛知県名古屋市緑区架空町1-2-3",
              address_source_url: "https://midori-kenchiku.example.jp/company/",
              found_via: { url: "https://kumiai.example.jp/members/" },
              fetched_at: at,
              official_site: {
                url: "https://midori-kenchiku.example.jp/",
                evidence_url: "https://midori-kenchiku.example.jp/company/",
                evidence: { company_name: "株式会社みどり建築", address: "愛知県名古屋市緑区架空町1-2-3" },
              },
            },
            {
              name: "架空ハウス株式会社",
              prefecture: "愛知県",
              city: "名古屋市北区",
              address: "愛知県名古屋市北区架空1-1",
              address_source_url: "https://kumiai.example.jp/members/",
              found_via: { url: "https://kumiai.example.jp/members/" },
              fetched_at: at,
              official_site: null,
            },
          ],
        }),
      );
      return { status: "completed", summary: "2社を見つけた" };
    };
    const r = await requestSkillRunByOps(e.deps, ops, {
      skill: "company-discovery",
      params: { prefecture: "愛知県", industry: "工務店", count: 2, chain: true },
    });
    if (!r.ok) throw new Error(r.error);
    // 受付は agent-web の収集ジョブを拾わない（取り込みが作成と同時に実行する）
    const intakeState = createIntakeState();
    await drain();
    expect(await intakeDiscoveryJobs(e.deps, intakeState)).toEqual([]);

    const run = await runOf(r.value.runId);
    expect(run.status).toBe("succeeded");
    expect(executor.calls[0]!.spec.prompt).toContain("件数：2社");
    expect(executor.calls[0]!.files).toContain(".agents/skills/site-evaluation/SKILL.md");
    const [job] = await e.db.select().from(discoveryJobs);
    expect(job).toMatchObject({ provider: "agent-web", status: "succeeded" });
    expect(run.result?.imported).toMatchObject({ discoveryJobId: job!.id, found: 2 });
    expect(existsSync(path.join(reportsRoot, run.result!.outputDir!, "candidates.json"))).toBe(true);
    const [midori] = await e.db.select().from(companies).where(eq(companies.name, "株式会社みどり建築"));
    const chained = await e.db.select().from(skillRuns).where(eq(skillRuns.trigger, "chain"));
    // 公式サイトのない企業は評価の前提条件に合わないため登録しない
    expect(chained).toMatchObject([{ skill: "site-evaluation", companyId: midori!.id, params: { chain: true } }]);
  });

  it("実行器の失敗・不正な最終応答・成果物なしは失敗として記録する（自動で再試行しない）", async () => {
    executor.behavior = async () => "fail";
    const a = await requestSkillRunByOps(e.deps, ops, { skill: "site-evaluation", params: {}, companyId });
    if (!a.ok) throw new Error(a.error);
    await drain();
    expect(await runOf(a.value.runId)).toMatchObject({ status: "failed", attempts: 1 });
    expect((await runOf(a.value.runId)).error).toContain("隔離生成の実行に失敗しました");
    expect(executor.calls).toHaveLength(1);

    executor.behavior = async () => ({ status: "completed", summary: "書いたつもり" });
    const b = await retrySkillRunByOps(e.deps, ops, a.value.runId);
    if (!b.ok) throw new Error(b.error);
    await drain();
    expect((await runOf(b.value.runId)).error).toBe("指定した出力先に成果物がありません");
    expect(await e.db.select().from(siteAudits)).toHaveLength(0);

    const events = await e.db.select().from(auditEvents).where(eq(auditEvents.targetType, "skill_run"));
    expect(events.map((x) => x.action)).toContain("skill_run.failed");
  });

  it("スキル実行を設定していないワーカーは拾わず、受付待ちのまま残す", async () => {
    delete e.deps.skills;
    const r = await requestSkillRunByOps(e.deps, ops, { skill: "site-evaluation", params: {}, companyId });
    if (!r.ok) throw new Error(r.error);
    expect(await drain()).toEqual([]);
    expect((await runOf(r.value.runId)).status).toBe("queued");
  });

  it("実行中のまま制限時間を過ぎた実行を失敗に戻す", async () => {
    const r = await requestSkillRunByOps(e.deps, ops, { skill: "site-evaluation", params: {}, companyId });
    if (!r.ok) throw new Error(r.error);
    await e.db
      .update(skillRuns)
      .set({ status: "running", startedAt: e.clock.now() })
      .where(eq(skillRuns.id, r.value.runId));
    expect(await recoverStaleSkillRuns(e.deps)).toEqual([]);
    e.clock.advance(2 * 60 * 60 * 1000);
    expect(await recoverStaleSkillRuns(e.deps)).toEqual([r.value.runId]);
    expect((await runOf(r.value.runId)).status).toBe("failed");
  });
});

describe("定期実行", () => {
  it("有効にした時点から間隔をおいて、対象を件数だけ登録する。同じ回を二重に登録しない", async () => {
    const other = await seedCompany("株式会社あおば工務店", "https://aoba-koumuten.example/");
    expect(
      await saveSkillScheduleByOps(e.deps, ops, {
        skill: "site-evaluation",
        enabled: true,
        intervalHours: 0,
        params: { limit: 1 },
      }),
    ).toMatchObject({ ok: false, error: "invalid_interval" });
    expect(
      await saveSkillScheduleByOps(e.deps, ops, {
        skill: "site-evaluation",
        enabled: true,
        intervalHours: 6,
        params: { limit: 1 },
      }),
    ).toMatchObject({ ok: true });
    expect(await dispatchSkillSchedules(e.deps)).toEqual([]);

    e.clock.advance(6 * 60 * 60 * 1000);
    const [first] = await dispatchSkillSchedules(e.deps);
    expect(first!.runIds).toHaveLength(1);
    expect(await dispatchSkillSchedules(e.deps)).toEqual([]);

    e.clock.advance(6 * 60 * 60 * 1000);
    const [second] = await dispatchSkillSchedules(e.deps);
    // 1回目の対象は実行待ちのため、もう1社を選ぶ
    const runs = await e.db.select().from(skillRuns).where(eq(skillRuns.trigger, "schedule"));
    expect(second!.runIds).toHaveLength(1);
    expect(new Set(runs.map((r) => r.companyId))).toEqual(new Set([companyId, other]));

    await saveSkillScheduleByOps(e.deps, ops, {
      skill: "site-evaluation",
      enabled: false,
      intervalHours: 6,
      params: { limit: 1 },
    });
    e.clock.advance(24 * 60 * 60 * 1000);
    expect(await dispatchSkillSchedules(e.deps)).toEqual([]);
    const [row] = await e.db.select().from(skillSchedules).where(and(eq(skillSchedules.skill, "site-evaluation")));
    expect(row).toMatchObject({ enabled: false, nextRunAt: null });
  });
});

it("受付で拾わない agent-web の収集ジョブは、取り込みの外で作られても待機のまま残す", async () => {
  const job = await createDiscoveryJob(e.db, e.clock, { provider: "agent-web", criteria: { prefecture: "愛知県" } });
  if (!job.ok) throw new Error(job.error);
  expect(await intakeDiscoveryJobs(e.deps, createIntakeState())).toEqual([]);
  const [row] = await e.db.select().from(discoveryJobs).where(eq(discoveryJobs.id, job.value.jobId));
  expect(row!.status).toBe("queued");
});
