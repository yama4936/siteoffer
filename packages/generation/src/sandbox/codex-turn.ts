import path from "node:path";
import type { Codex, ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import type { SandboxRequest, SandboxResult } from "./types.ts";

/**
 * Codex SDKで1回のターンを実行する（コンテナ内で動く部分）。
 * 1ジョブ1スレッド：毎回 startThread し、resumeThread は使わない。
 * テストでは Codex の代わりに同じ形の偽物を渡す。この関数をコンテナ外から呼ぶ経路は作らない。
 */
export type CodexLike = Pick<Codex, "startThread">;

export interface CodexTurnContext {
  codex: CodexLike;
  /** コンテナ内の作業ディレクトリ */
  workingDirectory: string;
  sdkVersion: string | null;
  cliVersion: string | null;
  signal?: AbortSignal;
  /** イベントの記録先（生成ログ） */
  onEvent?: (e: ThreadEvent) => void;
}

export async function runCodexTurn(req: SandboxRequest, ctx: CodexTurnContext): Promise<SandboxResult> {
  const threadOptions: ThreadOptions = {
    workingDirectory: ctx.workingDirectory,
    // 作業ディレクトリはGitリポジトリではない（ジョブ用の一時ディレクトリ）
    skipGitRepoCheck: true,
    sandboxMode: req.thread.sandboxMode,
    networkAccessEnabled: req.thread.networkAccessEnabled,
    webSearchMode: req.thread.webSearchMode,
    approvalPolicy: req.thread.approvalPolicy,
  };
  if (req.model !== null) threadOptions.model = req.model;
  if (req.thread.modelReasoningEffort !== null) threadOptions.modelReasoningEffort = req.thread.modelReasoningEffort;

  const turnOptions: TurnOptions = {};
  if (req.outputSchema !== null) turnOptions.outputSchema = req.outputSchema;
  if (ctx.signal) turnOptions.signal = ctx.signal;

  const input =
    req.images.length === 0
      ? req.prompt
      : [
          { type: "text" as const, text: req.prompt },
          ...req.images.map((p) => ({ type: "local_image" as const, path: path.resolve(ctx.workingDirectory, p) })),
        ];

  const result: SandboxResult = {
    ok: false,
    threadId: null,
    finalResponse: null,
    usage: null,
    responseModel: null,
    sdkVersion: ctx.sdkVersion,
    cliVersion: ctx.cliVersion,
    error: null,
  };

  const thread = ctx.codex.startThread(threadOptions);
  try {
    // run() ではなく runStreamed() を使い、失敗したターンでもスレッドIDとusageを残す
    const { events } = await thread.runStreamed(input, turnOptions);
    for await (const e of events) {
      ctx.onEvent?.(e);
      switch (e.type) {
        case "thread.started":
          result.threadId = e.thread_id;
          break;
        case "item.completed":
          if (e.item.type === "agent_message") result.finalResponse = e.item.text;
          break;
        case "turn.completed":
          result.usage = { ...e.usage };
          result.ok = true;
          break;
        case "turn.failed":
          result.error = e.error.message;
          break;
        case "error":
          result.error = e.message;
          break;
      }
    }
  } catch (e) {
    result.ok = false;
    result.error = (e as Error).message;
  }
  result.threadId ??= thread.id;
  if (result.error !== null) result.ok = false;
  return result;
}
