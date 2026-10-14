/**
 * 生成用コンテナのエントリ（DockerSandboxRunner が docker run で起動する）。
 * /work/request.json を読み、Codex SDKで1スレッド1ターンを実行し、/work/out/result.json に結果を書く。
 *
 * - コンテナ外では動かさない：SITEOFFER_SANDBOX=1 がなければ何もせず終了する。
 * - Codex CLIへの環境変数は許可したものだけを渡す（SDKの env 指定で process.env を継承させない）。
 * - この環境（Dockerなし・Codex未ログイン）では実行確認していない。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import { runCodexTurn } from "./codex-turn.ts";
import {
  SANDBOX_EVENTS_FILE,
  SANDBOX_REQUEST_FILE,
  SANDBOX_RESULT_FILE,
  type SandboxResult,
  sandboxRequestSchema,
} from "./types.ts";
import { readCodexVersions } from "./versions.ts";

/** Codex CLIに渡してよい環境変数（コンテナ内の値） */
const CODEX_ENV_ALLOWLIST = ["PATH", "HOME", "CODEX_HOME", "LANG", "TZ"] as const;
const MAX_ERROR_LENGTH = 2000;

async function main(): Promise<number> {
  if (process.env.SITEOFFER_SANDBOX !== "1") {
    console.error("container-entry: SITEOFFER_SANDBOX=1 のコンテナ内でのみ実行できる");
    return 2;
  }
  const workDir = process.cwd();
  const resultPath = path.join(workDir, SANDBOX_RESULT_FILE);
  const eventsPath = path.join(workDir, SANDBOX_EVENTS_FILE);
  mkdirSync(path.dirname(resultPath), { recursive: true });

  const { sdkVersion, cliVersion } = readCodexVersions();
  const write = (r: SandboxResult) => writeFileSync(resultPath, JSON.stringify(r));

  const parsed = sandboxRequestSchema.safeParse(
    JSON.parse(readFileSync(path.join(workDir, SANDBOX_REQUEST_FILE), "utf8")),
  );
  if (!parsed.success) {
    write({
      ok: false,
      threadId: null,
      finalResponse: null,
      usage: null,
      responseModel: null,
      sdkVersion,
      cliVersion,
      error: `request.json が不正: ${parsed.error.message.slice(0, MAX_ERROR_LENGTH)}`,
    });
    return 1;
  }

  const env: Record<string, string> = {};
  for (const k of CODEX_ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  const codex = new Codex({ env });
  const result = await runCodexTurn(parsed.data, {
    codex,
    workingDirectory: workDir,
    sdkVersion,
    cliVersion,
    onEvent: (e) => appendFileSync(eventsPath, `${JSON.stringify(e)}\n`),
  });
  if (result.error !== null) result.error = result.error.slice(0, MAX_ERROR_LENGTH);
  write(result);
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`container-entry: ${(e as Error).message}`);
    process.exit(1);
  },
);
