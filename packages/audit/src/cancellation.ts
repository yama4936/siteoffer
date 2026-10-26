export class AuditAbortedError extends Error {
  constructor() {
    super("診断処理が中断されました。元の依頼の状態を確認してください。");
  }
}
export function checkAuditSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new AuditAbortedError();
}
/** 応答しない外部処理でも、診断側は中断を記録して終了する。遅い結果は次の工程へ渡さない。 */
export async function abortableAudit<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkAuditSignal(signal);
  if (!signal) return run();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new AuditAbortedError());
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await Promise.race([run(), stopped]);
    checkAuditSignal(signal);
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
