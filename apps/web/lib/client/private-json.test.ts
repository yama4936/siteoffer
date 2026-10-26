import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateReadFailure, readPrivateJson } from "./private-json";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const json = (value: unknown = { value: "fresh" }) => Response.json(value);

describe("bounded private GET transport", () => {
  it("uses only same-origin uncached GETs and releases its deadline on success", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(json());
    vi.stubGlobal("fetch", fetcher);
    const result = await readPrivateJson("/fixture");
    expect(result.body).toEqual({ value: "fresh" });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start an already cancelled request", async () => {
    const fetcher = vi.fn(),
      controller = new AbortController();
    vi.stubGlobal("fetch", fetcher);
    controller.abort();
    await expect(readPrivateJson("/fixture", { signal: controller.signal, retryOnce: true })).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["headers", "body"])("ends cancellation while %s ignores the abort signal", async (stage) => {
    vi.useFakeTimers();
    const controller = new AbortController(),
      waiting = gate<unknown>(),
      entered = gate<void>();
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: () => {
        entered.resolve();
        return waiting.promise;
      },
    };
    const fetcher = vi
      .fn()
      .mockImplementation(() => (stage === "headers" ? waiting.promise : Promise.resolve(response)));
    vi.stubGlobal("fetch", fetcher);
    const work = readPrivateJson("/fixture", { signal: controller.signal, retryOnce: true }),
      rejected = expect(work).rejects.toBeDefined();
    if (stage === "body") await entered.promise;
    controller.abort();
    await rejected;
    expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    waiting.resolve(stage === "headers" ? json({ late: true }) : { late: true });
    await Promise.resolve();
  });

  it.each(["headers", "body"])("enforces the deadline while %s ignores abort", async (stage) => {
    vi.useFakeTimers();
    const waiting = gate<unknown>(),
      entered = gate<void>();
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: () => {
        entered.resolve();
        return waiting.promise;
      },
    };
    const fetcher = vi
      .fn()
      .mockImplementation(() => (stage === "headers" ? waiting.promise : Promise.resolve(response)));
    vi.stubGlobal("fetch", fetcher);
    const work = readPrivateJson("/fixture", { timeoutMs: 100 }),
      rejected = expect(work).rejects.toMatchObject({ code: "timeout" });
    if (stage === "body") await entered.promise;
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
    waiting.resolve(stage === "headers" ? json({ late: true }) : { late: true });
    await Promise.resolve();
  });

  it.each([408, 500, 502, 503, 504])(
    "recovers once from HTTP %i and discards the unread error body",
    async (status) => {
      vi.useFakeTimers();
      const errorResponse = Response.json({ error: "private-server-details" }, { status }),
        cancel = vi.spyOn(errorResponse.body!, "cancel"),
        onRetry = vi.fn();
      const fetcher = vi.fn().mockResolvedValueOnce(errorResponse).mockResolvedValueOnce(json());
      vi.stubGlobal("fetch", fetcher);
      const work = readPrivateJson("/fixture", { retryOnce: true, onRetry });
      await vi.advanceTimersByTimeAsync(0);
      expect(onRetry).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(400);
      expect((await work).body).toEqual({ value: "fresh" });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("recovers once from a network failure without exposing its original message", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("private-url-details")).mockResolvedValueOnce(json());
    vi.stubGlobal("fetch", fetcher);
    const work = readPrivateJson("/fixture", { retryOnce: true });
    await vi.advanceTimersByTimeAsync(400);
    expect((await work).body).toEqual({ value: "fresh" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a timed-out attempt cannot replace the successful retry with its late result", async () => {
    vi.useFakeTimers();
    const waiting = gate<Response>(),
      fetcher = vi
        .fn()
        .mockImplementationOnce(() => waiting.promise)
        .mockResolvedValueOnce(json({ source: "retry" })),
      onRetry = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const work = readPrivateJson("/fixture", { timeoutMs: 100, retryOnce: true, onRetry });
    await vi.advanceTimersByTimeAsync(100);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    const result = await work;
    expect(result.body).toEqual({ source: "retry" });
    waiting.resolve(json({ source: "too late" }));
    await Promise.resolve();
    expect(result.body).toEqual({ source: "retry" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends after the second timeout and does not retry indefinitely", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<Response>(() => {})),
      onRetry = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const work = readPrivateJson("/fixture", { timeoutMs: 100, retryOnce: true, onRetry }),
      rejected = expect(work).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(600);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the retry delay without starting another request", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 503 })),
      onRetry = vi.fn(),
      controller = new AbortController();
    vi.stubGlobal("fetch", fetcher);
    const work = readPrivateJson("/fixture", { signal: controller.signal, retryOnce: true, onRetry }),
      rejected = expect(work).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(onRetry).toHaveBeenCalledTimes(1);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403, 404, 429])("does not retry HTTP %i", async (status) => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: "unavailable" }, { status })),
      onRetry = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await readPrivateJson("/fixture", { retryOnce: true, onRetry });
    expect(result.response.status).toBe(status);
    expect(onRetry).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("respects a server's retry instruction instead of immediately retrying", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 503, headers: { "Retry-After": "60" } }));
    vi.stubGlobal("fetch", fetcher);
    expect((await readPrivateJson("/fixture", { retryOnce: true })).response.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, "interrupted"],
    [403, "stalled"],
    [503, "interrupted"],
    [503, "stalled"],
  ] as const)("does not retry HTTP %i when its error body is %s", async (status, body) => {
    vi.useFakeTimers();
    const entered = gate<void>(),
      waiting = gate<unknown>(),
      onRetry = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status,
      headers: new Headers({ "Content-Type": "application/json", ...(status === 503 ? { "Retry-After": "60" } : {}) }),
      json: () => {
        entered.resolve();
        return body === "interrupted" ? Promise.reject(new TypeError("broken body")) : waiting.promise;
      },
    });
    vi.stubGlobal("fetch", fetcher);
    const work = readPrivateJson("/fixture", { timeoutMs: 100, retryOnce: true, onRetry }),
      rejected = expect(work).rejects.toMatchObject({ retryable: false });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    waiting.resolve({ error: "too late" });
  });

  it.each(["html", "json"])("does not retry invalid %s data as a transient failure", async (kind) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        kind === "html"
          ? new Response("<html>login</html>")
          : new Response("not-json", { headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(readPrivateJson("/fixture", { retryOnce: true })).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps retries opt-in and preserves only safe failure information", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("private-url-details"));
    vi.stubGlobal("fetch", fetcher);
    const result = await readPrivateJson("/fixture").catch((error) => error);
    expect(result).toBeInstanceOf(PrivateReadFailure);
    expect(result.code).toBe("network");
    expect(result.message).not.toContain("private-url-details");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
