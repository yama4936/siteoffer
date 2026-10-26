export class GenerationWaitAborted extends Error {}

/**
 * プロセス内の同時実行数の上限。
 * 複数プロセス（ワーカー）をまたぐ上限はジョブキュー側（pg-boss の同時実行設定、T11）で持つ。
 */
export class ConcurrencyLimiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  readonly max: number;

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`同時実行数の上限が不正: ${max}`);
    this.max = max;
  }

  get active(): number {
    return this.running;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new GenerationWaitAborted("生成の待機を中断しました");
    if (this.running >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          signal?.removeEventListener("abort", cancel);
          resolve();
        };
        const cancel = () => {
          const index = this.waiting.indexOf(grant);
          if (index >= 0) this.waiting.splice(index, 1);
          signal?.removeEventListener("abort", cancel);
          reject(new GenerationWaitAborted("生成の待機を中断しました"));
        };
        this.waiting.push(grant);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    } else this.running++;
    try {
      if (signal?.aborted) throw new GenerationWaitAborted("生成の待機を中断しました");
      return await fn();
    } finally {
      // 解放枠は待機者に直接渡す。再開のmicrotaskまでに別の呼び出しが割り込んでも上限を超えない。
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}
