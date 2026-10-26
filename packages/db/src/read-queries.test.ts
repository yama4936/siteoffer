import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Db } from "./db.ts";
import { runReadQueries } from "./read-queries.ts";
import { createTestDb } from "./testing.ts";

let db: Db, close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.execute(sql`create table query_read_probe(value integer)`);
});
afterAll(async () => close());
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

it("keeps independent pool reads parallel and returns their original order", async () => {
  const held = gate(),
    started: number[] = [];
  const result = runReadQueries(db, [
    async () => {
      started.push(1);
      await held.promise;
      await db.execute(sql`select 1`);
      return "first";
    },
    async () => {
      started.push(2);
      await db.execute(sql`select 2`);
      return "second";
    },
  ]);
  try {
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
  } finally {
    held.resolve();
  }
  expect(await result).toEqual(["first", "second"]);
});

it("does not start another transaction read until the current one settles", async () => {
  await db.transaction(async (tx) => {
    const held = gate(),
      started: number[] = [];
    const result = runReadQueries(tx, [
      async () => {
        started.push(1);
        await held.promise;
        await tx.execute(sql`select 1`);
        return 1;
      },
      async () => {
        started.push(2);
        await tx.execute(sql`select 2`);
        return 2;
      },
    ]);
    try {
      await Promise.resolve();
      expect(started).toEqual([1]);
    } finally {
      held.resolve();
    }
    expect(await result).toEqual([1, 2]);
    expect(started).toEqual([1, 2]);
  });
});

it("stops after a failed SQL read, rolls back and leaves the database usable", async () => {
  const later = vi.fn(() => db.execute(sql`select 2`));
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`insert into query_read_probe values(1)`);
      await runReadQueries(tx, [() => tx.execute(sql`select 1/0`), later]);
    }),
  ).rejects.toThrow();
  expect(later).not.toHaveBeenCalled();
  const rows = (await db.execute(sql`select count(*)::int as n from query_read_probe`)) as { rows: { n: number }[] };
  expect(rows.rows[0]).toMatchObject({ n: 0 });
});

it("treats a synchronous failure as a transaction failure and never starts later reads", async () => {
  const later = vi.fn();
  await expect(
    db.transaction((tx) =>
      runReadQueries(tx, [
        () => {
          throw new Error("fixture read failed");
        },
        later,
      ]),
    ),
  ).rejects.toThrow("fixture read failed");
  expect(later).not.toHaveBeenCalled();
  const rows = (await db.execute(sql`select 1 as n`)) as { rows: { n: number }[] };
  expect(rows.rows[0]).toMatchObject({ n: 1 });
});

it("also serializes savepoints and preserves tuple and empty results", async () => {
  await db.transaction((outer) =>
    outer.transaction(async (tx) => {
      const calls: string[] = [];
      const result: [number, string] = await runReadQueries(tx, [
        async () => {
          calls.push("first");
          await Promise.resolve();
          calls.push("settled");
          return 1;
        },
        () => {
          calls.push("second");
          return "ok";
        },
      ]);
      expect(result).toEqual([1, "ok"]);
      expect(calls).toEqual(["first", "settled", "second"]);
      expect(await runReadQueries(tx, [])).toEqual([]);
    }),
  );
});
