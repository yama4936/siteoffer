import { randomUUID } from "node:crypto";
import { getRewardSummary } from "@siteoffer/core";
import { type contracts, type Db, type DbOrTx, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getContractsLedger } from "./contract-ledger";
import { seedContractLedgerFixture } from "./contract-ledger.test-fixture";
import type { seedUser } from "./test-seed";

let db: Db, close: () => Promise<void>;
let ops: Awaited<ReturnType<typeof seedUser>>["actor"];
let sales: Awaited<ReturnType<typeof seedUser>>["actor"];
let records: (typeof contracts.$inferSelect)[];
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ ops, sales, records } = await seedContractLedgerFixture(db));
});
afterAll(async () => close());
function must<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

it("reaches all 240 contracts with bounded, stable pages even across equal timestamps", async () => {
  const ids: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = must(await getContractsLedger(db, ops, { page, sort: "newest" }));
    expect(result).toMatchObject({ total: 240, pages: 10, page, pending: 96, unpaid: 24 });
    expect(result.rows.length).toBe(page === 10 ? 15 : 25);
    ids.push(...result.rows.map((row) => row.c.id));
  }
  expect(new Set(ids).size).toBe(240);
  expect(new Set(ids)).toEqual(new Set(records.map((row) => row.id)));
});

it("searches old contracts and treats SQL wildcard and punctuation characters literally", async () => {
  for (const q of ["全件検索の目印", "%", "_", "\\", records[239]!.id.toUpperCase()]) {
    const result = must(await getContractsLedger(db, ops, { q }));
    expect(result.total, q).toBe(1);
    expect(result.rows[0]?.c.id).toBe(records[239]!.id);
  }
  expect(must(await getContractsLedger(db, ops, { q: "' or 1=1 --" })).total).toBe(0);
  expect(must(await getContractsLedger(db, ops, { q: "営業乙" })).total).toBe(120);
});

it("filters the full ledger and keeps payment state independent of unpaid reward state", async () => {
  const pending = must(await getContractsLedger(db, ops, { status: "pending" }));
  expect(pending).toMatchObject({ total: 96, pending: 96, unpaid: 0 });
  const unpaid = must(await getContractsLedger(db, ops, { status: "completed", reward: "unpaid" }));
  expect(unpaid).toMatchObject({ total: 24, pending: 0, unpaid: 24 });
  expect(new Set(unpaid.rows.flatMap((row) => row.payments.map((payment) => payment.status)))).toEqual(
    new Set(["pending", "received"]),
  );
  expect(must(await getContractsLedger(db, ops, { reward: "none" })).total).toBe(192);
  for (const status of ["reported", "under_review", "completed", "rejected", "cancelled"] as const)
    expect(must(await getContractsLedger(db, ops, { status })).total).toBe(48);
  for (const reward of ["accrued", "scheduled", "paid", "cancelled"] as const)
    expect(must(await getContractsLedger(db, ops, { reward })).total).toBe(12);
});

it("prioritizes work, supports oldest first and clamps resolved or stale pages", async () => {
  const first = must(await getContractsLedger(db, ops));
  expect(first.rows.every((row) => ["reported", "under_review"].includes(row.c.status))).toBe(true);
  expect(must(await getContractsLedger(db, ops, { sort: "oldest" })).rows[0]?.c.id).toBe(records[239]!.id);
  expect(must(await getContractsLedger(db, ops, { page: 999 })).page).toBe(10);
  expect(must(await getContractsLedger(db, ops, { q: "no-such-company", page: 999 }))).toMatchObject({
    total: 0,
    page: 1,
    pages: 1,
    rows: [],
  });
});

it("preserves focused links past the old limit and restricts all finance details to their contract", async () => {
  const result = must(await getContractsLedger(db, ops, { focus: records[239]!.id.toUpperCase() }));
  expect(result.total).toBe(1);
  expect(result.rows[0]?.c.id).toBe(records[239]!.id);
  const completed = (
    await Promise.all(
      [1, 2].map(async (page) => must(await getContractsLedger(db, ops, { status: "completed", page }))),
    )
  ).flatMap((result) => result.rows);
  for (const row of completed) {
    expect(row.payments.every((payment) => payment.contractId === row.c.id)).toBe(true);
    expect(row.reward?.reward.contractId).toBe(row.c.id);
    expect(row.reward).toEqual(await getRewardSummary(db, row.reward!.reward.id));
    expect(row.reward).toEqual(await getRewardSummary(db, row.reward!.reward.id.toUpperCase()));
    expect(row.reward?.currentAmount).toBe(
      row.reward?.reward.status === "cancelled" ? 0 : row.reward!.reward.amount + 75,
    );
  }
});

it("rejects non-operators, missing/suspended users, role impersonation and malformed filters", async () => {
  const untouched = new Proxy(
    {},
    {
      get() {
        throw new Error("unauthorized database read");
      },
    },
  ) as DbOrTx;
  expect(await getContractsLedger(untouched, null)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await getContractsLedger(untouched, sales)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await getContractsLedger(db, { kind: "ops", userId: sales.userId })).toMatchObject({
    ok: false,
    error: "forbidden",
  });
  expect(await getContractsLedger(db, { kind: "ops", userId: randomUUID() })).toMatchObject({
    ok: false,
    error: "forbidden",
  });
  const [inactive] = await db
    .insert(users)
    .values({
      email: "inactive-ledger@example.test",
      passwordHash: "fixture",
      displayName: "停止運営",
      role: "ops",
      status: "suspended",
    })
    .returning();
  expect(await getContractsLedger(db, { kind: "ops", userId: inactive!.id })).toMatchObject({
    ok: false,
    error: "forbidden",
  });
  for (const filters of [{ focus: "bad" }, { page: -1 }, { status: "bad" }, { q: "x".repeat(201) }])
    expect(await getContractsLedger(db, ops, filters as never)).toMatchObject({ ok: false, error: "invalid_input" });
});
