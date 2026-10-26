import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pools: [] as {
    options: Record<string, unknown>;
    emit: (event: string, error: Error) => boolean;
    end: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: {
      Pool: class extends EventEmitter {
        options: Record<string, unknown>;
        query = vi.fn();
        end = vi.fn(async () => {});
        constructor(options: Record<string, unknown>) {
          super();
          this.options = options;
          state.pools.push(this);
        }
      },
    },
  };
});

import { createDb } from "./client.ts";

afterEach(() => {
  state.pools.length = 0;
  vi.restoreAllMocks();
});
it("preserves default connection options, permits a bounded lookup pool, handles idle errors without secrets, and closes each pool", async () => {
  const regular = createDb("postgres://localhost/example"),
    limited = createDb("postgres://localhost/example", {
      max: 4,
      connectionTimeoutMillis: 2000,
      query_timeout: 3000,
      statement_timeout: 3000,
    });
  expect(state.pools[0]!.options).toEqual({ connectionString: "postgres://localhost/example" });
  expect(state.pools[1]!.options).toMatchObject({
    max: 4,
    connectionTimeoutMillis: 2000,
    query_timeout: 3000,
    statement_timeout: 3000,
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(() => state.pools[1]!.emit("error", new Error("private connection details"))).not.toThrow();
  expect(warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private connection details");
  await regular.close();
  await limited.close();
  for (const pool of state.pools) expect(pool.end).toHaveBeenCalledOnce();
});
