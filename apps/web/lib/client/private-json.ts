"use client";

export type PrivateReadFailureCode = "timeout" | "network" | "invalid_response" | "forbidden" | "not_found";
export class PrivateReadFailure extends Error {
  readonly code: PrivateReadFailureCode;
  readonly retryable: boolean;
  constructor(code: PrivateReadFailureCode, retryable = true) {
    super(
      code === "timeout"
        ? "Read timed out"
        : code === "invalid_response"
          ? "Invalid read response"
          : "Private read failed",
    );
    this.code = code;
    this.retryable = retryable;
  }
}
class TransientReadFailure extends Error {}
type Options = {
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  retryOnce?: boolean;
  onRetry?: (() => void) | undefined;
};
type Result = { response: Response; body: unknown };

async function attempt(
  path: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  canRetry: boolean,
): Promise<Result> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>,
    cancel!: () => void,
    timedOut = false,
    retryable = true,
    completed = false;
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      controller.abort(signal?.reason);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      reject(new PrivateReadFailure("timeout"));
      controller.abort();
    }, timeoutMs);
  });
  const reading = (async () => {
    const response = await fetch(path, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    // An error body's interrupted transfer must not turn a terminal HTTP response into a retry.
    retryable = response.ok;
    if (canRetry && [408, 500, 502, 503, 504].includes(response.status) && !response.headers.has("retry-after")) {
      void response.body?.cancel().catch(() => {});
      throw new TransientReadFailure();
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      void response.body?.cancel().catch(() => {});
      throw new PrivateReadFailure("invalid_response");
    }
    return { response, body: (await response.json()) as unknown };
  })();
  try {
    // The deadline also bounds a body reader or transport that ignores AbortSignal.
    const result = await Promise.race([reading, interrupted]);
    signal?.throwIfAborted();
    completed = true;
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (timedOut) throw new PrivateReadFailure("timeout", retryable);
    if (error instanceof PrivateReadFailure || error instanceof TransientReadFailure) throw error;
    throw new PrivateReadFailure(error instanceof SyntaxError ? "invalid_response" : "network", retryable);
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener("abort", cancel);
    if (!completed) controller.abort();
  }
}
async function waitToRetry(signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(finish, 400);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
/** Read-only transport. Retries are opt-in, limited to one, and never apply to Server Action writes. */
export async function readPrivateJson(path: string, options: Options = {}): Promise<Result> {
  const { signal, timeoutMs = 20000, retryOnce = false, onRetry } = options;
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
    throw new Error("Invalid read policy");
  for (let i = 0; i < (retryOnce ? 2 : 1); i++) {
    try {
      return await attempt(path, signal, timeoutMs, retryOnce && i === 0);
    } catch (error) {
      signal?.throwIfAborted();
      if (
        i !== 0 ||
        !retryOnce ||
        !(
          error instanceof TransientReadFailure ||
          (error instanceof PrivateReadFailure && error.retryable && ["timeout", "network"].includes(error.code))
        )
      )
        throw error;
      onRetry?.();
      await waitToRetry(signal);
    }
  }
  throw new PrivateReadFailure("network");
}
