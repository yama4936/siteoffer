import type { SandboxRequest, SandboxRunner } from "@siteoffer/generation";

/**
 * スキルの実行場所。本番はジョブごとの使い捨てコンテナ（DockerSandboxRunner）で Codex SDK を動かす。
 * 生成（packages/generation の CodexGenerator）と違い、スキルは公開Webの調査とサイトの取得を行うため、
 * コンテナのネットワークと（探索・評価では）Web検索を有効にする。コンテナなしで実Codexを動かす実装は作らない。
 */
export interface SkillExecutionSpec {
  runId: string;
  /** ホスト側の作業ディレクトリ（コンテナの /work） */
  workDir: string;
  prompt: string;
  /** 最終応答の構造（JSON Schema） */
  outputSchema: Record<string, unknown>;
  webSearch: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type SkillExecution =
  | {
      ok: true;
      finalResponse: string | null;
      threadId: string | null;
      usage: Record<string, number> | null;
      /** コンテナが止まったことを確認できたか。確認できなければ作業ディレクトリを消さない */
      stopped: true;
    }
  | {
      ok: false;
      message: string;
      threadId: string | null;
      usage: Record<string, number> | null;
      stopped: boolean;
    };

export interface SkillExecutor {
  readonly kind: string;
  /** 要求モデル。null はSDK・CLIの既定（記録上は「既定」） */
  readonly requestedModel: string | null;
  execute(spec: SkillExecutionSpec): Promise<SkillExecution>;
}

export interface CodexSkillExecutorConfig {
  model?: string | null;
  sandboxMode?: SandboxRequest["thread"]["sandboxMode"];
}

export class CodexSkillExecutor implements SkillExecutor {
  readonly kind = "codex";
  readonly requestedModel: string | null;
  private readonly runner: SandboxRunner;
  private readonly config: CodexSkillExecutorConfig;

  constructor(runner: SandboxRunner, config: CodexSkillExecutorConfig = {}) {
    this.runner = runner;
    this.config = config;
    this.requestedModel = config.model ?? null;
  }

  async execute(spec: SkillExecutionSpec): Promise<SkillExecution> {
    const outcome = await this.runner.run({
      jobId: `skill-${spec.runId}`,
      workDir: spec.workDir,
      timeoutMs: spec.timeoutMs,
      ...(spec.signal ? { signal: spec.signal } : {}),
      request: {
        prompt: spec.prompt,
        outputSchema: spec.outputSchema,
        model: this.requestedModel,
        images: [],
        thread: {
          sandboxMode: this.config.sandboxMode ?? "workspace-write",
          networkAccessEnabled: true,
          webSearchMode: spec.webSearch ? "live" : "disabled",
          approvalPolicy: "never",
          modelReasoningEffort: null,
        },
      },
    });
    const threadId = outcome.result?.threadId ?? null;
    const usage = outcome.result?.usage ?? null;
    if (!outcome.ok) {
      const detail = outcome.result?.error ? `：${outcome.result.error.slice(0, 500)}` : "";
      return { ok: false, message: `${outcome.message}${detail}`, threadId, usage, stopped: outcome.stopped };
    }
    return { ok: true, finalResponse: outcome.result.finalResponse, threadId, usage, stopped: true };
  }
}
