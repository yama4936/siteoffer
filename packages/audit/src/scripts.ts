import { readFile } from "node:fs/promises";
import { err, ok, type Result } from "@siteoffer/core";
import { isReadableDiagnosticText } from "@siteoffer/schemas";
import type { Json } from "./collect.ts";
import { type AuditOptions, scriptPaths } from "./config.ts";
import type { PythonRunner } from "./python.ts";
import { tail } from "./python.ts";

export type ScoreError = "score_validation_failed" | "score_failed";

export interface ScoreSummary {
  total_score: number | null;
  score_confirmed: boolean;
  coverage: number;
  min_coverage: number;
  reason?: string;
  [k: string]: unknown;
}

/**
 * score.py を実行し、書き戻された evaluation.json を読み直す。
 * 終了コード1は検証エラー（根拠のない項目・項目不足など）。score.py は summary を null にしてから終わる。
 */
export async function runScore(
  runner: PythonRunner,
  options: AuditOptions,
  evaluationPath: string,
  signal?: AbortSignal,
): Promise<Result<{ evaluation: Json; summary: ScoreSummary; table: string }, ScoreError>> {
  const run = await runner.run(
    scriptPaths(options.paths).score,
    [evaluationPath, "--config", options.paths.configPath],
    {
      cwd: options.paths.repoRoot,
      timeoutMs: options.scriptTimeoutMs,
      ...(signal ? { signal } : {}),
    },
  );
  if (run.aborted) return err("score_failed", "採点処理を中断しました");
  if (run.timedOut) return err("score_failed", "score.py がタイムアウトした");
  if (run.exitCode === 1) return err("score_validation_failed", tail(run.stderr, 2000));
  if (run.exitCode !== 0)
    return err("score_failed", `score.py が異常終了した（exit ${run.exitCode}）: ${tail(run.stderr)}`);
  return parseScoredEvaluation(await readFile(evaluationPath, "utf8"), run.stdout);
}

export function parseScoredEvaluation(
  text: string,
  stdout: string,
): Result<{ evaluation: Json; summary: ScoreSummary; table: string }, ScoreError> {
  let evaluation: Json;
  try {
    evaluation = JSON.parse(text) as Json;
  } catch {
    return err("score_failed", "score.py の出力した evaluation.json を読めない");
  }
  const s = evaluation.summary;
  if (!s || typeof s !== "object" || !("total_score" in s)) {
    return err("score_failed", "evaluation.json に summary がない");
  }
  return ok({ evaluation, summary: s as ScoreSummary, table: stdout.trim() });
}

/** 提案書の作成判定。decide.py の pending はアプリでは hold（判定保留）として保存する */
export type Decision = "create" | "skip" | "hold";

export interface DecideResult {
  decision: Decision;
  reasons: string[];
  raw: Json;
}

export async function runDecide(
  runner: PythonRunner,
  options: AuditOptions,
  evaluationPath: string,
  signal?: AbortSignal,
): Promise<Result<DecideResult, "decide_failed">> {
  // --threshold はユーザーがその場で明示した値だけに使う（site-proposal）。アプリからは渡さない
  const run = await runner.run(
    scriptPaths(options.paths).decide,
    [evaluationPath, "--config", options.paths.configPath],
    {
      cwd: options.paths.repoRoot,
      timeoutMs: options.scriptTimeoutMs,
      ...(signal ? { signal } : {}),
    },
  );
  if (run.aborted) return err("decide_failed", "判定処理を中断しました");
  if (run.timedOut) return err("decide_failed", "decide.py がタイムアウトした");
  if (run.exitCode !== 0)
    return err("decide_failed", `decide.py が異常終了した（exit ${run.exitCode}）: ${tail(run.stderr)}`);
  return parseDecideOutput(run.stdout);
}

export function parseDecideOutput(stdout: string): Result<DecideResult, "decide_failed"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return err("decide_failed", "decide.py の出力がJSONでない");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return err("decide_failed", "decide.py の出力形式が不正です");
  const raw = parsed as Json;
  const map: Record<string, Decision> = { create: "create", skip: "skip", pending: "hold" };
  const decision = typeof raw.decision === "string" && Object.hasOwn(map, raw.decision) ? map[raw.decision] : undefined;
  if (!decision) return err("decide_failed", "decide.py の判定値を確認できません");
  if (!Array.isArray(raw.reasons) || raw.reasons.length === 0 || !raw.reasons.every(isReadableDiagnosticText))
    return err(
      "decide_failed",
      "decide.py の判定理由が欠落しているか、文字を正しく読み取れません。保存時の原資料と実行環境を確認してください",
    );
  return ok({ decision, reasons: [...raw.reasons], raw });
}

export async function readRubricVersion(options: AuditOptions): Promise<string> {
  try {
    const cfg = JSON.parse(await readFile(options.paths.configPath, "utf8")) as Json;
    return typeof cfg.rubric_version === "string" ? cfg.rubric_version : "0.1";
  } catch {
    return "0.1";
  }
}
