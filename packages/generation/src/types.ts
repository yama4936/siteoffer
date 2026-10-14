import type { z } from "zod";
import type { GenerationInput, GenerationPurpose } from "./schemas.ts";

/**
 * 1回の実行の記録（10.4・24.3）。
 * 取得できなかった値はnull。推測で埋めない。
 */
export interface ExecutionRecord {
  /** codex / mock */
  generator: string;
  /** 設定で要求したモデルID。未指定（SDK既定）ならnull */
  requestedModel: string | null;
  /** 応答に含まれていたモデルID。SDKが返さなければnull */
  responseModel: string | null;
  sdkVersion: string | null;
  cliVersion: string | null;
  promptVersion: string;
  threadId: string | null;
  requestId: string | null;
  /** SDKが返した実測のusage。なければnull */
  usage: Record<string, number> | null;
}

export interface GenerateRequest<T> {
  purpose: GenerationPurpose;
  input: GenerationInput;
  outputSchema: z.ZodType<T>;
  /** ジョブの識別（作業ディレクトリ・コンテナ名に使う）。秘密値を入れない */
  jobId: string;
  attempt: number;
  /** 1回の試行のタイムアウト（GenerationLimits.timeoutMs）。実行場所（コンテナ）の打ち切りに使う */
  timeoutMs: number;
  signal?: AbortSignal;
}

export type GeneratorErrorCode =
  | "timeout"
  | "aborted"
  | "sandbox_error"
  | "empty_response"
  | "invalid_json"
  | "schema_violation"
  | "fact_violation";

export type GeneratorResult<T> =
  | { ok: true; output: T; record: ExecutionRecord }
  | { ok: false; error: GeneratorErrorCode; message: string; record: ExecutionRecord };

/** 生成の実行者。用途・入力・出力スキーマを受け取り、検証済みの出力と実行記録を返す */
export interface Generator {
  readonly kind: string;
  /** 用途ごとのプロンプト版（実行記録に入れる） */
  promptVersion(purpose: GenerationPurpose): string;
  /** 記録上の要求モデル（未指定ならnull） */
  readonly requestedModel: string | null;
  generate<T>(req: GenerateRequest<T>): Promise<GeneratorResult<T>>;
}
