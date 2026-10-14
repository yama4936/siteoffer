import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "@siteoffer/core";
import { type AuditOptions, scriptPaths } from "./config.ts";
import { type PythonRunner, type PythonRunResult, tail } from "./python.ts";

export type Json = Record<string, unknown>;

export type CollectOutcome =
  | {
      kind: "collected";
      collected: Json;
      collectedPath: string;
      /** 存在が確認できたスクリーンショット（成果物ディレクトリ内の絶対パス） */
      screenshotPaths: string[];
    }
  | {
      /** collect.py が fatal を返した（robots.txt の拒否・非公開アドレス・取得失敗など）。評価不能として扱う */
      kind: "fatal";
      reason: string;
      collected: Json;
      collectedPath: string;
    };

export type CollectError = "collect_failed";

/** 収集段のインターフェース。本番は collect.py、テスト・ローカル開発は取得済みフィクスチャ */
export interface SiteCollector {
  collect(url: string, outDir: string): Promise<Result<CollectOutcome, CollectError>>;
}

/** collect.py の引数。--config は常に絶対パスで渡す（スクリプトの既定値はカレントディレクトリ基準のため） */
export function buildCollectArgs(url: string, outDir: string, options: AuditOptions): string[] {
  const args = [url, "--out", outDir, "--config", options.paths.configPath];
  if (options.screenshot) args.push("--screenshot");
  if (options.psi) args.push("--psi");
  return args;
}

/**
 * collect.py の実行結果を解釈する。
 * 終了コード：0=成功、2=非公開アドレス等、3=robots.txt拒否、4=トップ取得失敗（2〜4は collected.json に fatal を書く）。
 * それ以外の異常終了・タイムアウト・collected.json の欠落は、評価不能ではなくこちら側の失敗（再試行の対象）。
 */
export function parseCollectRun(
  run: PythonRunResult,
  collectedText: string | null,
  outDir: string,
): Result<CollectOutcome, CollectError> {
  if (run.timedOut) return err("collect_failed", "collect.py がタイムアウトした");
  const collectedPath = path.join(outDir, "collected.json");
  let collected: Json | null = null;
  if (collectedText !== null) {
    try {
      const parsed: unknown = JSON.parse(collectedText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) collected = parsed as Json;
    } catch {
      collected = null;
    }
  }
  if (collected && typeof collected.fatal === "string" && collected.fatal) {
    return ok({ kind: "fatal", reason: collected.fatal, collected, collectedPath });
  }
  if (run.exitCode === 0 && collected) {
    return ok({ kind: "collected", collected, collectedPath, screenshotPaths: screenshotPathsOf(collected, outDir) });
  }
  return err(
    "collect_failed",
    `collect.py が異常終了した（exit ${run.exitCode ?? "なし"}）${collected ? "" : "。collected.json がない"}: ${tail(run.stderr)}`,
  );
}

/** collected.json の screenshots から、成果物ディレクトリ内に実在するPNGだけを返す */
export function screenshotPathsOf(collected: Json, outDir: string): string[] {
  const shots = collected.screenshots;
  if (!shots || typeof shots !== "object") return [];
  const root = path.resolve(outDir);
  const result: string[] = [];
  for (const key of ["mobile", "desktop"]) {
    const v = (shots as Json)[key];
    if (typeof v !== "string" || !v.endsWith(".png")) continue;
    const abs = path.resolve(outDir, v);
    if (abs.startsWith(root + path.sep) && existsSync(abs)) result.push(abs);
  }
  return result;
}

/** collect.py をサブプロセス（python3 -I）で実行する収集段 */
export function createPythonCollector(runner: PythonRunner, options: AuditOptions): SiteCollector {
  return {
    async collect(url, outDir) {
      await mkdir(outDir, { recursive: true });
      const extraEnv: Record<string, string> = {};
      if (options.psi && process.env.PSI_API_KEY) extraEnv.PSI_API_KEY = process.env.PSI_API_KEY;
      const run = await runner.run(scriptPaths(options.paths).collect, buildCollectArgs(url, outDir, options), {
        cwd: options.paths.repoRoot,
        timeoutMs: options.collectTimeoutMs,
        extraEnv,
      });
      const text = await readFile(path.join(outDir, "collected.json"), "utf8").catch(() => null);
      return parseCollectRun(run, text, outDir);
    },
  };
}

/**
 * 取得済みの collected.json を成果物ディレクトリへ写して使う収集段（テスト・ローカル開発用）。
 * collect.py は公開アドレス以外（127.0.0.1等）への取得を拒否し、それを迂回する正規のオプションがないため、
 * ローカルの架空サイトで評価済みの流れを確認するときはこちらを使う。
 */
export function createFixtureCollector(collectedFixturePath: string): SiteCollector {
  return {
    async collect(_url, outDir) {
      await mkdir(outDir, { recursive: true });
      const dest = path.join(outDir, "collected.json");
      await copyFile(collectedFixturePath, dest);
      const text = await readFile(dest, "utf8");
      return parseCollectRun({ exitCode: 0, stdout: "", stderr: "", timedOut: false }, text, outDir);
    },
  };
}
