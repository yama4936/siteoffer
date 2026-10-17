"use client";

export type PrivateReadResult<T> = { ok: true; result: T } | { ok: false; message: string };
/** Bound read waits and keep them outside the Server Action mutation queue. */
export async function readPrivate<T>(path: string, signal?: AbortSignal): Promise<PrivateReadResult<T>> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Read timed out")), 20000);
  try {
    const response = await fetch(path, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const body = await response.json();
    controller.signal.throwIfAborted();
    if (!response.ok || body?.ok === false)
      return {
        ok: false,
        message:
          typeof body?.message === "string" ? body.message : "最新の状況を取得できません。再度更新してください。",
      };
    if (body?.ok !== true || !("result" in body)) throw new Error("Invalid read response");
    return body as PrivateReadResult<T>;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}
