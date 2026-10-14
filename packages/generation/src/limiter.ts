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

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
