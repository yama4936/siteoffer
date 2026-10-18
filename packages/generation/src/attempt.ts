import type { z } from "zod";
import type { GenerationFeedback } from "./feedback.ts";
import type { SandboxStopReference } from "./sandbox/types.ts";
import type { GenerationInput, GenerationPurpose } from "./schemas.ts";
import type { ExecutionRecord, Generator, GeneratorResult } from "./types.ts";

export function emptyRecord(generator: Generator, purpose: GenerationPurpose): ExecutionRecord {
  return {
    generator: generator.kind,
    requestedModel: generator.requestedModel,
    responseModel: null,
    sdkVersion: null,
    cliVersion: null,
    promptVersion: generator.promptVersion(purpose),
    threadId: null,
    requestId: null,
    usage: null,
  };
}

/** Retain the execution slot while cancellation settles. A late success is never adopted. */
export async function attemptOnce<T>(
  generator: Generator,
  purpose: GenerationPurpose,
  input: GenerationInput,
  outputSchema: z.ZodType<T>,
  jobId: string,
  attempt: number,
  timeoutMs: number,
  stopTimeoutMs: number,
  signal?: AbortSignal,
  saveStopReference?: (reference: SandboxStopReference) => Promise<void>,
  retryFeedback?: GenerationFeedback,
): Promise<{ result: GeneratorResult<T>; late?: Promise<GeneratorResult<T>> }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let cause: "timeout" | "aborted" | undefined;
  let notify!: () => void;
  const cancelled = new Promise<null>((resolve) => {
    notify = () => resolve(null);
  });
  const cancel = (reason: "timeout" | "aborted") => {
    if (cause) return;
    cause = reason;
    controller.abort();
    notify();
  };
  const onAbort = () => cancel("aborted");
  const failure = (
    error: "timeout" | "aborted" | "sandbox_stop_unconfirmed",
    previous?: GeneratorResult<T>,
  ): GeneratorResult<T> => ({
    ok: false,
    error,
    message:
      error === "sandbox_stop_unconfirmed"
        ? "生成の終了を確認できません。自動再試行を止め、停止確認を待っています。"
        : error === "timeout"
          ? "生成が制限時間を超えたため中断し、終了を確認しました。"
          : "元の処理が中断されたため生成を停止し、終了を確認しました。",
    record: previous?.record ?? emptyRecord(generator, purpose),
    ...(previous?.stopReference ? { stopReference: previous.stopReference } : {}),
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) return { result: failure("aborted") };
    timer = setTimeout(() => cancel("timeout"), timeoutMs);
    const running = Promise.resolve()
      .then(() =>
        generator.generate({
          purpose,
          input,
          outputSchema,
          jobId,
          attempt,
          timeoutMs,
          signal: controller.signal,
          ...(saveStopReference ? { saveStopReference } : {}),
          ...(retryFeedback ? { retryFeedback } : {}),
        }),
      )
      .catch(() => failure("sandbox_stop_unconfirmed"));
    let result = await Promise.race([running, cancelled]);
    if (cause && result === null) {
      const expired = new Promise<null>((resolve) => {
        stopTimer = setTimeout(() => resolve(null), stopTimeoutMs);
      });
      result = await Promise.race([running, expired]);
      if (result === null) return { result: failure("sandbox_stop_unconfirmed"), late: running };
    }
    if (result === null) return { result: failure("sandbox_stop_unconfirmed") };
    if ((!result.ok && result.error === "sandbox_stop_unconfirmed") || result.stopReference?.stopped === false)
      return { result: failure("sandbox_stop_unconfirmed", result) };
    return { result: cause ? failure(cause, result) : result };
  } finally {
    clearTimeout(timer);
    clearTimeout(stopTimer);
    signal?.removeEventListener("abort", onAbort);
  }
}
