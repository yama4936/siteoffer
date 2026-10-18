import { z } from "zod";

/**
 * コンテナ内でCodex SDKに渡す依頼（作業ディレクトリの request.json）。
 * パスはすべて作業ディレクトリからの相対パス。秘密値を入れない。
 */
export const sandboxRequestSchema = z.strictObject({
  /** Host-generated receipt identity, not model input. */
  executionId: z.string().uuid().optional(),
  prompt: z.string().min(1),
  /** 構造化出力のJSON Schema。サイトのファイル生成など構造化しない場合はnull */
  outputSchema: z.record(z.string(), z.unknown()).nullable(),
  /** 要求モデル。nullならSDK・CLIの既定 */
  model: z.string().nullable(),
  /** 画像の添付（作業ディレクトリからの相対パス） */
  images: z.array(z.string()),
  thread: z.strictObject({
    sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]),
    networkAccessEnabled: z.boolean(),
    webSearchMode: z.enum(["disabled", "cached", "live"]),
    approvalPolicy: z.enum(["never", "on-request", "on-failure", "untrusted"]),
    modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable(),
  }),
});
export type SandboxRequest = z.infer<typeof sandboxRequestSchema>;

/** コンテナから取り出す結果（作業ディレクトリの out/result.json） */
export const sandboxResultSchema = z.strictObject({
  executionId: z.string().uuid().optional(),
  ok: z.boolean(),
  threadId: z.string().nullable(),
  finalResponse: z.string().nullable(),
  usage: z.record(z.string(), z.number()).nullable(),
  /** SDKのイベントに応答モデルは含まれない（0.162.1時点）。将来取れた場合だけ入れる */
  responseModel: z.string().nullable(),
  sdkVersion: z.string().nullable(),
  cliVersion: z.string().nullable(),
  error: z.string().nullable(),
});
export type SandboxResult = z.infer<typeof sandboxResultSchema>;

export interface SandboxRunSpec {
  /** ジョブの識別子（コンテナ名に使う。英数字と-_のみ） */
  jobId: string;
  /** ホスト側の作業ディレクトリ（このジョブの入力ファイルだけを置いた一時ディレクトリ） */
  workDir: string;
  request: SandboxRequest;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type SandboxRunOutcome =
  | { ok: true; result: SandboxResult }
  | { ok: false; error: "timeout" | "aborted" | "sandbox_error"; message: string; result: SandboxResult | null };

/**
 * Codexの実行場所。実行は必ずこのインターフェースを通す。
 * 本番はジョブごとの使い捨てコンテナ（DockerSandboxRunner）。コンテナなしで実Codexを動かす実装は作らない。
 */
export interface SandboxRunner {
  readonly kind: string;
  run(spec: SandboxRunSpec): Promise<SandboxRunOutcome>;
}

export const SANDBOX_WORKDIR = "/work";
export const SANDBOX_REQUEST_FILE = "request.json";
export const SANDBOX_RESULT_FILE = "out/result.json";
export const SANDBOX_EVENTS_FILE = "out/events.jsonl";
