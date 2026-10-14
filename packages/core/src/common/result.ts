/**
 * 業務ロジックの戻り値。想定内の失敗（権限なし・競合・条件未達など）は例外にせず err で返す。
 * 想定外の失敗（DB障害など）は例外のまま投げる。
 */
export type Result<T, E extends string = string> = { ok: true; value: T } | { ok: false; error: E; message?: string };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E extends string>(error: E, message?: string): Result<never, E> =>
  message === undefined ? { ok: false, error } : { ok: false, error, message };
