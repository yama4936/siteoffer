import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Actor } from "@siteoffer/core";
import { companies, type SkillName, siteAudits, skillRuns, websites } from "@siteoffer/db";
import type { AgentWebOptions } from "@siteoffer/discovery";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { WorkerDeps } from "../deps.ts";
import { parseSkillParams, SKILL_DIRS, SKILL_TIMEOUT_MS, SKILL_WEB_SEARCH, type SkillParams } from "./definitions.ts";
import { importCandidates } from "./discovery-import.ts";
import { importEvaluationDir } from "./evaluation-import.ts";
import type { SkillExecutor } from "./executor.ts";
import { summarizeAiCheck } from "./precheck.ts";
import { buildSkillPrompt, SKILL_OUTPUT_SCHEMA, type SkillPromptInput, WORKSPACE_AGENTS_MD } from "./prompt.ts";
import { importSkillProposalVersion } from "./proposal-import.ts";
import {
  claimSkillRun,
  createSkillRun,
  finishSkillRun,
  retrySkillRunBySystem,
  type SkillFailureKind,
  type WorkerSkillRunResult,
} from "./runs.ts";
import { type AuditTarget, type CompanyTarget, checkSkillTarget } from "./targets.ts";
import { copyTree, dirExists, isPlainDir, OutputLimitError, readPlainJson } from "./workspace.ts";

/** スキル実行の部品（ワーカーの設定 SITEOFFER_SKILL_RUNNER=codex のときだけ組み立てる） */
export interface SkillDeps {
  executor: SkillExecutor;
  /** 作業ディレクトリを作る親（Docker デーモンからも同じパスで見える場所） */
  workRoot: string;
  /** 成果物の置き場所（reports/）。Gitに入れない */
  reportsRoot: string;
  /** スキル・要件書の写し元（リポジトリのルート） */
  repoRoot: string;
  keepWorkDir?: boolean;
  /** 探索結果の実在確認（公式サイトの取得・国税庁API）の差し替え。テスト用。省略時は実際に取得する */
  discovery?: AgentWebOptions;
}

export const SKILL_ACTOR: Actor = { kind: "system", job: "skill-run" };

const finalSchema = z.object({
  status: z.enum(["completed", "skipped", "blocked"]),
  summary: z.string().max(8000),
  output_dir: z.string().max(500),
});

type Run = typeof skillRuns.$inferSelect;
/** 次に登録するスキル。提案書とサイト作成は同じ対象キーを使うため、この実行を終えてから登録する */
type Chain = { skill: SkillName; targets: { companyId?: string; auditId?: string }[]; params: Record<string, unknown> };
type SkillRunResult = WorkerSkillRunResult;
type Outcome = { status: "succeeded" | "failed"; result: SkillRunResult; error?: string; chain?: Chain };

/** 失敗の結果。失敗の種類を result.failureKind に入れる（自動の再試行の判断に使う） */
function failed(kind: SkillFailureKind, error: string, result: SkillRunResult = {}): Outcome {
  return { status: "failed", result: { ...result, failureKind: kind }, error };
}

const EXECUTION_FAILURE: Record<string, SkillFailureKind> = {
  timeout: "timeout",
  aborted: "interrupted",
  sandbox_error: "executor_error",
  // 停止を確認できないコンテナが動き続けている可能性がある間は、二重に起動しない
  sandbox_stop_unconfirmed: "executor_stop_unconfirmed",
};

/** Asia/Tokyo の日付（YYYY-MM-DD）。スキルの出力先の日付ディレクトリに使う */
export function tokyoDate(now: Date) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now);
}

/**
 * 1件の実行を行う。受付待ち→実行中にできたときだけ動き、成果物の取り込みと連鎖まで終えて記録する。
 * 一時的な失敗（制限時間切れ・中断・実行器の異常・最終応答の形式違反）は1回だけ自動で再試行を登録する。
 * それ以外の失敗は自動では繰り返さない（実Codexの費用がかかるため。運営が画面から再実行する）。
 */
export async function executeSkillRun(deps: WorkerDeps, runId: string, signal?: AbortSignal) {
  const run = await claimSkillRun(deps.db, deps.clock, runId);
  if (!run) return { status: "skipped" as const };
  let outcome: Outcome;
  try {
    outcome = await runClaimed(deps, run, signal);
  } catch (e) {
    deps.logger.error("スキルの実行に失敗した", { runId, message: (e as Error).message });
    outcome =
      e instanceof OutputLimitError
        ? failed("output_limit", e.message)
        : failed("internal_error", "スキルの実行中に予期しないエラーが発生しました。ワーカーのログを確認してください");
  }
  const finished = await finishSkillRun(deps.db, deps.clock, runId, outcome);
  if (finished && outcome.status === "failed") await autoRetry(deps, runId);
  if (finished && outcome.status === "succeeded" && outcome.chain) {
    try {
      const chainedRunIds = await chainRuns(deps, run, outcome.chain);
      if (chainedRunIds.length)
        await deps.db
          .update(skillRuns)
          .set({ result: { ...outcome.result, chainedRunIds } })
          .where(eq(skillRuns.id, runId));
    } catch (e) {
      deps.logger.error("次のスキルの登録に失敗した", { runId, message: (e as Error).message });
    }
  }
  return { status: outcome.status };
}

async function runClaimed(deps: WorkerDeps, run: Run, signal?: AbortSignal): Promise<Outcome> {
  const skills = deps.skills;
  if (!skills)
    return failed(
      "not_configured",
      "このワーカーではスキル実行が設定されていません（SITEOFFER_SKILL_RUNNER=codex と実行用イメージの設定が必要です）",
    );
  const target = await checkSkillTarget(deps.db, run.skill, { companyId: run.companyId, auditId: run.auditId });
  if (!target.ok) return failed("precondition", target.reason);
  const params = parseSkillParams(run.skill, run.params);
  if (!params.success) return failed("precondition", "起動条件が不正です");

  await mkdir(skills.workRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(skills.workRoot, `skill-${run.id}-`));
  let stopped = true;
  try {
    const date = tokyoDate(deps.clock.now());
    const prepared = await prepareWorkspace(deps, skills, run, workDir, date, target.value, params.data);
    const execution = await skills.executor.execute({
      runId: run.id,
      workDir,
      prompt: buildSkillPrompt(prepared.prompt),
      outputSchema: SKILL_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      webSearch: SKILL_WEB_SEARCH[run.skill],
      timeoutMs: SKILL_TIMEOUT_MS[run.skill],
      ...(signal ? { signal } : {}),
    });
    stopped = execution.stopped;
    const base: SkillRunResult = {
      threadId: execution.threadId,
      usage: execution.usage,
      requestedModel: skills.executor.requestedModel,
    };
    if (!execution.ok)
      return failed(EXECUTION_FAILURE[execution.reason ?? ""] ?? "executor_error", execution.message, base);
    let final: z.infer<typeof finalSchema>;
    try {
      final = finalSchema.parse(JSON.parse(execution.finalResponse ?? ""));
    } catch {
      return failed("invalid_final_response", "スキルの最終応答が指定の形式ではありません", base);
    }
    const result = { ...base, summary: final.summary, outcome: final.status };
    return await collect(deps, skills, run, workDir, prepared.outRel, target.value, params.data, final.status, result);
  } finally {
    // 停止を確認できないコンテナが作業ディレクトリをマウントしている可能性がある間は消さない
    if (stopped && !skills.keepWorkDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function prepareWorkspace(
  deps: WorkerDeps,
  skills: SkillDeps,
  run: Run,
  workDir: string,
  date: string,
  target: CompanyTarget | AuditTarget | null,
  params: SkillParams<SkillName>,
): Promise<{ outRel: string; prompt: SkillPromptInput }> {
  for (const name of SKILL_DIRS[run.skill]) {
    await copyTree(path.join(skills.repoRoot, ".agents/skills", name), path.join(workDir, ".agents/skills", name), {
      overwrite: true,
      filter: (rel) => !/^scripts\/test_/.test(rel),
    });
  }
  await mkdir(path.join(workDir, "config"), { recursive: true });
  await copyFile(deps.audit.options.paths.configPath, path.join(workDir, "config/site-evaluation.json"));
  await copyFile(path.join(skills.repoRoot, "REQUIREMENTS.md"), path.join(workDir, "REQUIREMENTS.md"));
  await writeFile(path.join(workDir, "AGENTS.md"), WORKSPACE_AGENTS_MD);
  await mkdir(path.join(workDir, "input"), { recursive: true });

  switch (run.skill) {
    case "company-discovery": {
      const outRel = `reports/discovery/${date}-skill-${run.id.slice(0, 8)}`;
      await mkdir(path.join(workDir, outRel), { recursive: true });
      await writeFile(
        path.join(workDir, "input/known-companies.json"),
        JSON.stringify(await knownCompanies(deps), null, 1),
      );
      return {
        outRel,
        prompt: { skill: run.skill, params: params as SkillParams<"company-discovery">, outDir: outRel, date },
      };
    }
    case "site-evaluation": {
      const { company, website } = target as CompanyTarget;
      const outRel = `reports/sites/${website.domain}/${date}`;
      return {
        outRel,
        prompt: { skill: run.skill, outDir: outRel, date, target: { url: website.url, companyName: company.name } },
      };
    }
    case "site-proposal":
    case "site-rebuild": {
      const { audit, website } = target as AuditTarget;
      const outRel = `reports/sites/${website.domain}/${path.basename(audit.artifactDir!)}`;
      await copyTree(audit.artifactDir!, path.join(workDir, outRel), { overwrite: true });
      return { outRel, prompt: { skill: run.skill, outDir: outRel } };
    }
  }
}

/** 探索の照合用（scripts/import-discovery.ts --check の代わり）。営業抑止・評価の有無を含む */
async function knownCompanies(deps: WorkerDeps) {
  const rows = await deps.db
    .select({
      name: companies.name,
      corporate_number: companies.corporateNumber,
      pipeline_status: companies.pipelineStatus,
      suppression: companies.suppression,
      domains: sql<
        string[]
      >`coalesce(array_agg(distinct ${websites.domain}) filter (where ${websites.domain} is not null), '{}')`,
      audited: sql<boolean>`exists (select 1 from ${siteAudits} where ${siteAudits.companyId} = ${companies.id})`,
    })
    .from(companies)
    .leftJoin(websites, eq(websites.companyId, companies.id))
    .groupBy(companies.id)
    .orderBy(desc(companies.createdAt))
    .limit(5000);
  return rows;
}

async function collect(
  deps: WorkerDeps,
  skills: SkillDeps,
  run: Run,
  workDir: string,
  outRel: string,
  target: CompanyTarget | AuditTarget | null,
  params: SkillParams<SkillName>,
  status: "completed" | "skipped" | "blocked",
  result: SkillRunResult,
): Promise<Outcome> {
  if (!(await isPlainDir(workDir, outRel)))
    return status === "completed"
      ? failed("artifact_missing", "指定した出力先に成果物がありません", result)
      : { status: "succeeded", result };
  const src = path.join(workDir, outRel);

  switch (run.skill) {
    case "company-discovery": {
      const dest = await freshDir(path.join(skills.reportsRoot, "discovery"), path.basename(outRel));
      await copyTree(src, dest, { overwrite: false });
      result.outputDir = path.relative(skills.reportsRoot, dest);
      if (status !== "completed") return { status: "succeeded", result };
      const raw = await readPlainJson(src, "candidates.json");
      if (raw === null) return failed("artifact_missing", "candidates.json がないか、JSONとして読めません", result);
      const imported = await importCandidates(deps.db, deps.clock, raw, SKILL_ACTOR, skills.discovery);
      if (!imported.ok) return failed("import_failed", imported.message ?? imported.error, result);
      const s = imported.value;
      result.imported = {
        discoveryJobId: s.jobId,
        status: s.status,
        found: s.found,
        created: s.created,
        updated: s.updated,
        skipped: s.skipped,
        failed: s.failed,
      };
      if ((params as SkillParams<"company-discovery">).chain) {
        const ids = [...new Set(s.companies.map((c) => c.companyId).filter((id): id is string => !!id))];
        if (s.status !== "failed")
          return {
            status: "succeeded",
            result,
            chain: {
              skill: "site-evaluation",
              targets: ids.map((companyId) => ({ companyId })),
              params: { chain: true },
            },
          };
      }
      return s.status === "failed"
        ? failed("import_failed", "収集ジョブの取り込みに失敗しました", result)
        : { status: "succeeded", result };
    }
    case "site-evaluation": {
      const { company, website } = target as CompanyTarget;
      if (!existsSync(path.join(src, "evaluation.json")))
        return status === "completed"
          ? failed("artifact_missing", "evaluation.json がありません", result)
          : { status: "succeeded", result };
      const dest = await freshDir(
        path.dirname(path.join(skills.reportsRoot, path.relative("reports", outRel))),
        path.basename(outRel),
      );
      await copyTree(src, dest, { overwrite: false });
      result.outputDir = path.relative(skills.reportsRoot, dest);
      const imported = await importEvaluationDir(
        { db: deps.db, clock: deps.clock, runner: deps.audit.runner, options: deps.audit.options },
        dest,
        { actor: SKILL_ACTOR, source: `skill_run:${run.id}`, target: { companyId: company.id, websiteId: website.id } },
      );
      if (imported.status === "failed")
        return failed("import_failed", `評価の取り込みに失敗しました：${imported.reason}`, result);
      result.imported = imported;
      if (
        (params as SkillParams<"site-evaluation">).chain &&
        imported.status === "imported" &&
        imported.evaluation === "evaluated" &&
        imported.decision === "create" &&
        imported.auditId
      )
        return {
          status: "succeeded",
          result,
          chain: { skill: "site-proposal", targets: [{ auditId: imported.auditId }], params: { chain: true } },
        };
      return { status: "succeeded", result };
    }
    case "site-proposal":
    case "site-rebuild": {
      const { audit } = target as AuditTarget;
      // 評価の成果物ディレクトリへ戻す。site/ がある評価は対象外にしているため、既存の改善後サイトは上書きしない
      const copied = await copyTree(src, audit.artifactDir!, { overwrite: true });
      result.outputDir = path.relative(skills.reportsRoot, audit.artifactDir!);
      result.changedFiles = copied.files.length;
      if (copied.skipped.length) result.skippedFiles = copied.skipped.slice(0, 50);
      if (run.skill === "site-proposal") {
        const hasProposal = (await readPlainJson(audit.artifactDir!, "proposal.json")) !== null;
        result.imported = { proposal: hasProposal };
        if (status === "completed" && !hasProposal)
          return failed("artifact_missing", "proposal.json がないか、JSONとして読めません", result);
        if (hasProposal && status === "completed" && (params as SkillParams<"site-proposal">).chain)
          return {
            status: "succeeded",
            result,
            chain: { skill: "site-rebuild", targets: [{ auditId: audit.id }], params: {} },
          };
        return { status: "succeeded", result };
      }
      if (!(await dirExists(path.join(audit.artifactDir!, "site"))))
        return status === "completed"
          ? failed("artifact_missing", "改善後サイト（site/）がありません", result)
          : { status: "succeeded", result };
      // 取り込みの前に、ワーカー自身がリポジトリの検査スクリプトで事前チェックする（作業ディレクトリの写しは使わない）
      const imported = await importSkillProposalVersion(deps.db, deps.clock, SKILL_ACTOR, audit.id, {
        repoRoot: skills.repoRoot,
      });
      if (!imported.ok)
        return imported.error === "precheck_unavailable"
          ? failed("precheck_unavailable", `AIの事前チェックを実行できません：${imported.message ?? ""}`, result)
          : failed("import_failed", `提案版の取り込みに失敗しました（${imported.error}）`, result);
      const version = imported.value.version;
      result.imported = {
        proposalVersionId: version.id,
        version: version.version,
        status: version.status,
        created: imported.value.created,
        ...(imported.value.aiCheck ? { aiCheck: summarizeAiCheck(imported.value.aiCheck) } : {}),
      };
      if (version.status === "failed") {
        const failure = (version.content as { failure?: unknown } | null)?.failure;
        return failed("precheck_failed", typeof failure === "string" ? failure : "AIの事前チェックに不合格", result);
      }
      return { status: "succeeded", result };
    }
  }
}

/** 既存の成果物を上書きしないよう、同名があれば -2, -3… を付けた別名にする */
async function freshDir(parent: string, name: string) {
  await mkdir(parent, { recursive: true });
  let dest = path.join(parent, name);
  for (let i = 2; existsSync(dest); i++) dest = path.join(parent, `${name}-${i}`);
  await mkdir(dest, { recursive: true });
  return dest;
}

/** 前のスキルの結果から次のスキルを登録する。前提条件に合わない対象は登録しない */
async function chainRuns(deps: WorkerDeps, parent: Run, { skill, targets, params }: Chain) {
  const ids: string[] = [];
  for (const t of targets) {
    const r = await createSkillRun(deps.db, deps.clock, {
      skill,
      params,
      trigger: "chain",
      companyId: t.companyId ?? null,
      auditId: t.auditId ?? null,
      parentRunId: parent.id,
      createdBy: parent.createdBy,
      actor: SKILL_ACTOR,
    });
    if (r.ok && r.value.created) ids.push(r.value.runId);
  }
  return ids;
}

/** 実行中のまま制限時間を大きく過ぎた実行を失敗に戻す（ワーカーの停止などで中断されたとみなす） */
export async function recoverStaleSkillRuns(deps: Pick<WorkerDeps, "db" | "clock">, graceMs = 15 * 60 * 1000) {
  const now = deps.clock.now().getTime();
  const running = await deps.db
    .select({ id: skillRuns.id, skill: skillRuns.skill, startedAt: skillRuns.startedAt })
    .from(skillRuns)
    .where(eq(skillRuns.status, "running"));
  const recovered: string[] = [];
  for (const r of running) {
    if (r.startedAt && now - r.startedAt.getTime() < SKILL_TIMEOUT_MS[r.skill] + graceMs) continue;
    const done = await finishSkillRun(deps.db, deps.clock, r.id, {
      status: "failed",
      result: { failureKind: "interrupted" } satisfies SkillRunResult,
      error: "実行中のまま制限時間を過ぎたため失敗に戻しました（ワーカーの停止などで中断されたとみなす）",
    });
    if (!done) continue;
    recovered.push(r.id);
    await autoRetry(deps, r.id);
  }
  return recovered;
}

/** 一時的な失敗なら1回だけ再試行を登録する。登録できなくても実行の記録は変えない */
async function autoRetry(deps: Pick<WorkerDeps, "db" | "clock"> & { logger?: WorkerDeps["logger"] }, runId: string) {
  try {
    const r = await retrySkillRunBySystem(deps, runId);
    if (r.ok && r.value.created)
      deps.logger?.info("一時的な失敗のため再試行を登録した", { runId, retryRunId: r.value.runId });
  } catch (e) {
    deps.logger?.error("再試行の登録に失敗した", { runId, message: (e as Error).message });
  }
}
