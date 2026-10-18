/**
 * 生成ジョブの上限設定（10.3・24.3）。値は推奨案（アシスタントの初期値）で、仕様として確定したものではない。
 * 運営設定（core の DEFAULT_SETTINGS）への組み込みは統合担当が判断する。
 */
export interface GenerationLimits {
  /** 1ジョブの最大試行回数（初回を含む） */
  maxAttempts: number;
  /** 1回の試行のタイムアウト（ミリ秒） */
  timeoutMs: number;
  /** 中断指示後に終了確認を待つ上限。終了未確認なら再試行しない。 */
  stopTimeoutMs: number;
  /** このプロセスで同時に実行する生成の上限 */
  maxConcurrent: number;
}

export const DEFAULT_GENERATION_LIMITS: GenerationLimits = {
  maxAttempts: 3,
  timeoutMs: 15 * 60 * 1000,
  stopTimeoutMs: 30_000,
  maxConcurrent: 2,
};

export function resolveLimits(partial?: Partial<GenerationLimits>): GenerationLimits {
  const l = { ...DEFAULT_GENERATION_LIMITS, ...partial };
  for (const [k, v] of Object.entries(l)) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`生成の上限設定 ${k} が不正: ${v}`);
  }
  if (l.stopTimeoutMs > 60_000) throw new Error("生成の停止確認は60秒以内に設定してください");
  return l;
}
