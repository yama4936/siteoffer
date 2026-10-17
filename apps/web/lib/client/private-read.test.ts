import { afterEach, describe, expect, it, vi } from "vitest";
import { readPrivate } from "./private-read";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function pendingFetch() {
  const fetcher = vi.fn(
    (_url: unknown, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
describe("private GET read lifecycle", () => {
  it("aborts an old read and lets a new read finish independently", async () => {
    const fetcher = pendingFetch(),
      controller = new AbortController();
    const old = readPrivate("/ops/materials/updates?kind=count", controller.signal);
    const outcome = expect(old).rejects.toBeDefined();
    controller.abort();
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: 3 }));
    expect(await readPrivate<number>("/ops/materials/updates?kind=count")).toEqual({ ok: true, result: 3 });
    await outcome;
    expect(fetcher.mock.calls[0]![1].signal?.aborted).toBe(true);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  });
  it("bounds a nonresponsive read, releases its timer, and permits retry", async () => {
    vi.useFakeTimers();
    const fetcher = pendingFetch(),
      result = readPrivate("/ops/work-queue");
    const rejection = expect(result).rejects.toThrow("Read timed out");
    await vi.advanceTimersByTimeAsync(20000);
    await rejection;
    expect(fetcher.mock.calls[0]![1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: { items: [] } }));
    expect((await readPrivate("/ops/work-queue")).ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start an already cancelled request", async () => {
    const fetcher = pendingFetch(),
      controller = new AbortController();
    controller.abort();
    await expect(readPrivate("/ops/work-queue", controller.signal)).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not accept login HTML, malformed successes, or an HTTP error as fresh data", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("<html>login</html>"))
        .mockResolvedValueOnce(Response.json({ ok: true }))
        .mockResolvedValueOnce(Response.json({ ok: true, result: { items: [] } }, { status: 503 }))
        .mockResolvedValueOnce(Response.json({ ok: false, message: "ログインし直してください。" }, { status: 401 })),
    );
    await expect(readPrivate("/ops/work-queue")).rejects.toBeDefined();
    await expect(readPrivate("/ops/work-queue")).rejects.toThrow("Invalid read response");
    expect((await readPrivate("/ops/work-queue")).ok).toBe(false);
    expect(await readPrivate("/ops/work-queue")).toEqual({ ok: false, message: "ログインし直してください。" });
  });
  it("rejects a response body that finishes after cancellation", async () => {
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    const body = new Promise((resolve) => {
      finish = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => body }));
    const request = readPrivate("/ops/work-queue", controller.signal);
    const outcome = expect(request).rejects.toBeDefined();
    await Promise.resolve();
    controller.abort();
    finish({ ok: true, result: { items: [] } });
    await outcome;
  });
});
