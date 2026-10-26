import type { SandboxResult, SandboxRunner, SandboxRunOutcome, SandboxRunSpec } from "./types.ts";

/**
 * テスト用の実行場所。Codexを動かさず、あらかじめ渡した応答を順に返す。
 * 受け取った依頼は calls に残す（プロンプト・出力スキーマ・作業ディレクトリの確認用）。
 */
export type NoopResponse = Partial<SandboxResult> | { fail: "timeout" | "aborted" | "sandbox_error"; message?: string };

export class NoopSandboxRunner implements SandboxRunner {
  readonly kind = "noop";
  readonly calls: SandboxRunSpec[] = [];
  private readonly responses: NoopResponse[];

  /** 応答が尽きたら最後の応答を繰り返す */
  constructor(responses: NoopResponse[]) {
    if (responses.length === 0) throw new Error("NoopSandboxRunner には応答を1つ以上渡す");
    this.responses = responses;
  }

  async run(spec: SandboxRunSpec): Promise<SandboxRunOutcome> {
    this.calls.push(spec);
    const r = this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)]!;
    if ("fail" in r) return { ok: false, error: r.fail, message: r.message ?? r.fail, result: null, stopped: true };
    const result: SandboxResult = {
      ok: true,
      threadId: null,
      finalResponse: null,
      usage: null,
      responseModel: null,
      sdkVersion: null,
      cliVersion: null,
      error: null,
      ...r,
    };
    if (!result.ok)
      return { ok: false, error: "sandbox_error", message: result.error ?? "失敗", result, stopped: true };
    return { ok: true, result, stopped: true };
  }
}
