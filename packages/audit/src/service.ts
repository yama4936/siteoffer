import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Actor, type Clock, err, ok, type Result, recordEvent } from "@siteoffer/core";
import { type DbOrTx, findings, siteAudits, websites } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import { AuditAbortedError, abortableAudit, checkAuditSignal } from "./cancellation.ts";
import type { SiteCollector } from "./collect.ts";
import { type AuditOptions, artifactDirFor, scriptPaths } from "./config.ts";
import { type CriticalFlag, checkEvidence, prepareEvaluation, unevaluableEvaluation } from "./evaluation.ts";
import { buildEvaluationPrompt, type EvaluationGenerator } from "./generator.ts";
import { categoryOf } from "./items.ts";
import type { PythonRunner } from "./python.ts";
import { type Decision, readRubricVersion, runDecide, runScore } from "./scripts.ts";

export interface AuditDeps {
  collector: SiteCollector;
  generator: EvaluationGenerator;
  runner: PythonRunner;
  options: AuditOptions;
}

export interface RunSiteAuditInput {
  websiteId: string;
  actor: Actor;
  signal?: AbortSignal;
}

export type AuditOutcomeStatus = "evaluated" | "unevaluable" | "failed";

export interface RunSiteAuditOutput {
  auditId: string;
  status: AuditOutcomeStatus;
  decision: Decision | null;
  artifactDir: string;
  /** status=failed のときの理由 */
  failureReason?: string;
}

export type RunSiteAuditError = "website_not_found" | "invalid_url" | "aborted";

type AuditPatch = Partial<typeof siteAudits.$inferInsert>;

const TARGET = "site_audit";

/**
 * サイト診断を1回実行する：collect.py → 生成器による採点 → score.py → decide.py → 保存。
 * 診断ごとに site_audits の新しい行と成果物ディレクトリを作り、過去の診断を消さない（再診断）。
 * 取得できなかったサイトは評価不能（unevaluable）として保存し、低評価に置き換えない。
 * スクリプトの異常終了・検証エラー・生成失敗は failed とし、項目（findings）を保存しない。
 */
export async function runSiteAudit(
  db: DbOrTx,
  clock: Clock,
  deps: AuditDeps,
  input: RunSiteAuditInput,
): Promise<Result<RunSiteAuditOutput, RunSiteAuditError>> {
  if (input.signal?.aborted) return err("aborted", "診断処理が中断されました");
  const [site] = await db.select().from(websites).where(eq(websites.id, input.websiteId));
  if (!site) return err("website_not_found");
  let url: URL;
  try {
    url = new URL(site.url);
  } catch {
    return err("invalid_url", "URLとして解釈できない");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return err("invalid_url", "HTTP/HTTPS以外のURL");

  const auditId = crypto.randomUUID();
  const artifactDir = artifactDirFor(deps.options.paths.artifactRoot, url.href, auditId, clock.now());
  await db.transaction(async (tx) => {
    await tx.insert(siteAudits).values({
      id: auditId,
      companyId: site.companyId,
      websiteId: site.id,
      targetUrl: url.href,
      status: "collecting",
      attempts: 1,
      artifactDir,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    await recordEvent(tx, clock, {
      actor: input.actor,
      action: "site_audit.started",
      targetType: TARGET,
      targetId: auditId,
      after: { status: "collecting", websiteId: site.id, targetUrl: url.href },
    });
  });

  const update = async (patch: AuditPatch, action: string) => {
    await db.transaction(async (tx) => {
      await tx.select({ id: siteAudits.id }).from(siteAudits).where(eq(siteAudits.id, auditId)).for("update");
      if (patch.status !== "failed") checkAuditSignal(input.signal);
      await tx
        .update(siteAudits)
        .set({ ...patch, updatedAt: clock.now() })
        .where(eq(siteAudits.id, auditId));
      await recordEvent(tx, clock, {
        actor: input.actor,
        action,
        targetType: TARGET,
        targetId: auditId,
        after: {
          status: patch.status,
          decision: patch.decision,
          reason: patch.failureReason ?? patch.unevaluableReason,
        },
      });
      if (patch.status !== "failed") checkAuditSignal(input.signal);
    });
  };
  const fail = async (reason: string): Promise<Result<RunSiteAuditOutput, RunSiteAuditError>> => {
    await update({ status: "failed", failureReason: reason }, "site_audit.failed");
    return ok({ auditId, status: "failed", decision: null, artifactDir, failureReason: reason });
  };

  const run = <T>(fn: () => Promise<T>) => abortableAudit(fn, input.signal);
  try {
    checkAuditSignal(input.signal);
    await mkdir(artifactDir, { recursive: true });
    const evaluationPath = path.join(artifactDir, "evaluation.json");
    const rubricVersion = await readRubricVersion(deps.options);

    // 1. 収集
    const collected = await run(() => deps.collector.collect(url.href, artifactDir, input.signal));
    if (!collected.ok) return fail(collected.message ?? collected.error);
    const c = collected.value;
    if (c.kind === "fatal") {
      return await finishUnevaluable(c.reason, c.collected.collected_at, url.href);
    }

    // 2. 採点（生成器）
    await update({ status: "scoring", fetchedAt: parseDate(c.collected.collected_at) }, "site_audit.scoring");
    const p = scriptPaths(deps.options.paths);
    const [rubric, outputFormat] = await Promise.all([readFile(p.rubric, "utf8"), readFile(p.outputFormat, "utf8")]);
    const genInput = {
      auditId,
      targetUrl: url.href,
      collected: c.collected,
      collectedPath: c.collectedPath,
      screenshotPaths: c.screenshotPaths,
      rubric,
      outputFormat,
      rubricPath: p.rubric,
      outputFormatPath: p.outputFormat,
    };
    const generated = await run(() =>
      deps.generator.generate({
        ...genInput,
        prompt: buildEvaluationPrompt(genInput),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
    if (!generated.ok) return fail(`採点の生成に失敗した: ${generated.message ?? generated.error}`);
    const evaluatedAt = clock.now();
    const prepared = prepareEvaluation(generated.value.evaluation, {
      collected: c.collected,
      evaluatedAt,
      model: generated.value.model,
      rubricVersion,
    });
    if (!prepared.ok) return fail(`採点結果の形式が不正: ${prepared.message}`);
    const ev = prepared.value;
    if (ev.status === "unevaluable") {
      const reason =
        typeof ev.fatal_reason === "string" && ev.fatal_reason ? ev.fatal_reason : "採点で評価不能と判断された";
      return await finishUnevaluable(reason, c.collected.collected_at, url.href);
    }
    const evidence = checkEvidence(ev.items);
    if (!evidence.ok) {
      await writeJson(evaluationPath, ev);
      return fail(`根拠のない項目がある: ${evidence.message}`);
    }
    await writeJson(evaluationPath, ev);

    // 3. 計算（score.py）
    const scored = await run(() => runScore(deps.runner, deps.options, evaluationPath, input.signal));
    if (!scored.ok) {
      const label = scored.error === "score_validation_failed" ? "score.py の検証エラー" : "score.py の実行に失敗";
      return fail(`${label}: ${scored.message}`);
    }
    await writeFile(path.join(artifactDir, "score-table.md"), `${scored.value.table}\n`);

    // 4. 判定（decide.py）
    const decided = await run(() => runDecide(deps.runner, deps.options, evaluationPath, input.signal));
    if (!decided.ok) return fail(decided.message ?? decided.error);
    await writeJson(path.join(artifactDir, "decision.json"), decided.value.raw);

    // 5. 保存
    const final = scored.value.evaluation;
    const summary = scored.value.summary;
    const items = checkEvidence(final.items);
    if (!items.ok) return fail(`根拠のない項目がある: ${items.message}`);
    const flags = (Array.isArray(final.critical_flags) ? final.critical_flags : []) as CriticalFlag[];
    const criticalItems = new Set(flags.map((f) => f.item).filter((i): i is string => typeof i === "string"));
    await db.transaction(async (tx) => {
      await tx.select({ id: siteAudits.id }).from(siteAudits).where(eq(siteAudits.id, auditId)).for("update");
      checkAuditSignal(input.signal);
      await tx
        .update(siteAudits)
        .set({
          status: "evaluated",
          finalUrl: typeof final.final_url === "string" ? final.final_url : null,
          rubricVersion: typeof summary.rubric_version === "string" ? summary.rubric_version : rubricVersion,
          totalScore: summary.total_score === null ? null : String(summary.total_score),
          coverage: String(summary.coverage),
          scoreConfirmed: summary.score_confirmed,
          criticalFlags: flags,
          summary,
          decision: decided.value.decision,
          decisionReason: decided.value.reasons.join("。"),
          evaluatorModel: generated.value.model,
          generationJobId: generated.value.generationJobId ?? null,
          evaluatedAt,
          updatedAt: clock.now(),
        })
        .where(eq(siteAudits.id, auditId));
      if (items.value.length) {
        await tx.insert(findings).values(
          items.value.map((it) => ({
            auditId,
            itemCode: it.id,
            category: categoryOf(it.id),
            status: it.status,
            score: it.status === "scored" ? (it.level ?? null) : null,
            reason: it.reason ?? null,
            observations: it.observations ?? [],
            improvementHint: it.improvement_hint ?? null,
            inference: it.inference === true,
            critical: criticalItems.has(it.id),
          })),
        );
      }
      await recordEvent(tx, clock, {
        actor: input.actor,
        action: "site_audit.evaluated",
        targetType: TARGET,
        targetId: auditId,
        after: {
          status: "evaluated",
          totalScore: summary.total_score,
          coverage: summary.coverage,
          decision: decided.value.decision,
          criticalFlags: flags.map((f) => f.id),
        },
      });
      checkAuditSignal(input.signal);
    });
    return ok({ auditId, status: "evaluated", decision: decided.value.decision, artifactDir });

    /** 評価不能：score.py・decide.py も通し、総合点なし・判定保留で保存する（低評価に置き換えない） */
    async function finishUnevaluable(
      reason: string,
      collectedAt: unknown,
      targetUrl: string,
    ): Promise<Result<RunSiteAuditOutput, RunSiteAuditError>> {
      const evaluatedAt = clock.now();
      await writeJson(
        evaluationPath,
        unevaluableEvaluation({ targetUrl, collectedAt, reason, evaluatedAt, rubricVersion }),
      );
      const scored = await run(() => runScore(deps.runner, deps.options, evaluationPath, input.signal));
      if (!scored.ok) return fail(`score.py の実行に失敗: ${scored.message}`);
      const decided = await run(() => runDecide(deps.runner, deps.options, evaluationPath, input.signal));
      if (!decided.ok) return fail(decided.message ?? decided.error);
      await writeJson(path.join(artifactDir, "decision.json"), decided.value.raw);
      await update(
        {
          status: "unevaluable",
          unevaluableReason: reason,
          totalScore: null,
          coverage: String(scored.value.summary.coverage),
          scoreConfirmed: false,
          summary: scored.value.summary,
          decision: decided.value.decision,
          decisionReason: decided.value.reasons.join("。"),
          rubricVersion,
          fetchedAt: parseDate(collectedAt),
          evaluatedAt,
        },
        "site_audit.unevaluable",
      );
      return ok({ auditId, status: "unevaluable", decision: decided.value.decision, artifactDir });
    }
  } catch (error) {
    return fail(
      error instanceof AuditAbortedError || input.signal?.aborted
        ? "診断処理が中断されました。元の依頼の状態を確認してください。"
        : "診断処理を完了できませんでした。取得・採点の設定とワーカーを確認してください。",
    );
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
