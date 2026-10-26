import { fixedClock } from "@siteoffer/core";
import { auditEvents, generationJobs } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGenerationJob } from "../src/jobs.ts";
import {
  GENERATION_HEARTBEAT_MS,
  GENERATION_LEASE_MS,
  generationConnectionLost,
  recoverExpiredGenerationJobs,
  renewGenerationLease,
} from "../src/lease.ts";
import { ConcurrencyLimiter } from "../src/limiter.ts";
import { MockGenerator } from "../src/mock.ts";
import type { Generator } from "../src/types.ts";
import { fixtureInput } from "./helpers.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let testDb: Awaited<ReturnType<typeof createTestDb>>;
let clock: ReturnType<typeof fixedClock>;
beforeEach(async () => {
  testDb = await createTestDb();
  clock = fixedClock("2026-10-17T00:00:00Z");
});
afterEach(async () => {
  vi.useRealTimers();
  await testDb.close();
});
const request = () => ({ idempotencyKey: "lease", companyId: null, purpose: "faq" as const, input: fixtureInput() });

describe("生成の接続切れと履歴の回復", () => {
  it("期限切れの待機・実行だけを閉じ、並行回復でも監査記録を重複させない", async () => {
    const { db } = testDb;
    const past = new Date(clock.now().getTime() - 1),
      future = new Date(clock.now().getTime() + GENERATION_LEASE_MS);
    const rows = await db
      .insert(generationJobs)
      .values(
        [
          { status: "queued" as const, leaseUntil: past },
          { status: "running" as const, leaseUntil: clock.now() },
          { status: "running" as const, leaseUntil: future },
          { status: "succeeded" as const, leaseUntil: past, output: { retained: true } },
          { status: "cancelled" as const, leaseUntil: past },
          { status: "running" as const, leaseUntil: null },
        ].map((r, i) => ({
          ...r,
          idempotencyKey: `seed-${i}`,
          purpose: "faq" as const,
          generator: "mock",
          promptVersion: "test",
        })),
      )
      .returning();
    expect(generationConnectionLost(rows[1]!, clock.now())).toBe(true);
    expect(generationConnectionLost(rows[2]!, clock.now())).toBe(false);
    const recovered = (
      await Promise.all([recoverExpiredGenerationJobs(db, clock), recoverExpiredGenerationJobs(db, clock)])
    ).flat();
    expect(new Set(recovered)).toEqual(new Set(rows.slice(0, 2).map((r) => r.id)));
    expect(recovered).toHaveLength(2);
    for (const row of rows.slice(0, 2)) {
      const [after] = await db.select().from(generationJobs).where(eq(generationJobs.id, row.id));
      expect(after).toMatchObject({
        status: "failed",
        errorCode: "interrupted",
        leaseUntil: null,
        finishedAt: clock.now(),
      });
      expect(await renewGenerationLease(db, clock, row.id)).toBe(false);
    }
    for (const row of rows.slice(2)) {
      const [after] = await db.select().from(generationJobs).where(eq(generationJobs.id, row.id));
      expect(after).toEqual(row);
    }
    expect(await db.select().from(auditEvents)).toHaveLength(2);
  });

  for (const sweep of [false, true])
    it(`停止した生成器が遅れて成功しても結果を保存しない（回復処理${sweep ? "済" : "前"}）`, async () => {
      const { db } = testDb,
        entered = deferred(),
        gate = deferred();
      const mock = new MockGenerator();
      const generator: Generator = {
        kind: "slow",
        requestedModel: null,
        promptVersion: () => "test",
        async generate(req) {
          entered.resolve();
          await gate.promise;
          return mock.generate(req);
        },
      };
      const result = runGenerationJob({ db, clock, generator }, request());
      try {
        await entered.promise;
        const [job] = await db.select().from(generationJobs);
        clock.advance(GENERATION_LEASE_MS);
        expect(await renewGenerationLease(db, clock, job!.id)).toBe(false);
        if (sweep) expect(await recoverExpiredGenerationJobs(db, clock)).toEqual([job!.id]);
        gate.resolve();
        expect((await result).ok).toBe(false);
        const [after] = await db.select().from(generationJobs);
        expect(after).toMatchObject({ status: "failed", errorCode: "interrupted", output: null, leaseUntil: null });
        const events = await db.select().from(auditEvents);
        expect(events.filter((e) => e.action === "generation.interrupted")).toHaveLength(1);
        expect(events.filter((e) => e.action === "generation.succeeded")).toHaveLength(0);
        const reuse = await runGenerationJob({ db, clock, generator: mock }, request());
        expect(reuse.ok && reuse.value).toMatchObject({ reused: true, output: null, job: { status: "failed" } });
        expect(mock.calls).toHaveLength(1);
      } finally {
        gate.resolve();
        await result;
      }
    });

  it("待機中も実行中も生存期限を延長し、完了後は通知を止める", async () => {
    const { db } = testDb,
      limiter = new ConcurrencyLimiter(1),
      slot = deferred(),
      entered = deferred(),
      output = deferred();
    const occupying = limiter.run(() => slot.promise);
    const mock = new MockGenerator();
    const generator: Generator = {
      kind: "hold",
      requestedModel: null,
      promptVersion: () => "test",
      async generate(req) {
        entered.resolve();
        await output.promise;
        return mock.generate(req);
      },
    };
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const result = runGenerationJob({ db, clock, generator, limiter }, request());
    try {
      await expect.poll(async () => (await db.select().from(generationJobs)).length).toBe(1);
      // 最初の2分を超えて待っても、更新が続いていれば期限切れにはしない。
      for (let i = 0; i < 7; i++) {
        clock.advance(GENERATION_HEARTBEAT_MS);
        await vi.advanceTimersByTimeAsync(GENERATION_HEARTBEAT_MS);
        await expect
          .poll(async () => (await db.select().from(generationJobs))[0]!.leaseUntil?.getTime())
          .toBe(clock.now().getTime() + GENERATION_LEASE_MS);
        expect(await recoverExpiredGenerationJobs(db, clock)).toEqual([]);
      }
      slot.resolve();
      await occupying;
      await entered.promise;
      clock.advance(GENERATION_HEARTBEAT_MS);
      await vi.advanceTimersByTimeAsync(GENERATION_HEARTBEAT_MS);
      await expect
        .poll(async () => (await db.select().from(generationJobs))[0]!.leaseUntil?.getTime())
        .toBe(clock.now().getTime() + GENERATION_LEASE_MS);
      output.resolve();
      expect((await result).ok).toBe(true);
      const [completed] = await db.select().from(generationJobs);
      expect(completed).toMatchObject({ status: "succeeded", leaseUntil: null });
      clock.advance(GENERATION_LEASE_MS);
      await vi.advanceTimersByTimeAsync(GENERATION_LEASE_MS);
      expect(await db.select().from(generationJobs)).toEqual([completed]);
    } finally {
      slot.resolve();
      output.resolve();
      await occupying;
      await result;
    }
  });

  it("100件ずつ回復し、残りを次の周期で処理する", async () => {
    const { db } = testDb;
    await db.insert(generationJobs).values(
      Array.from({ length: 101 }, (_, i) => ({
        idempotencyKey: `batch-${i}`,
        purpose: "faq" as const,
        generator: "mock",
        promptVersion: "test",
        status: "queued" as const,
        leaseUntil: clock.now(),
      })),
    );
    expect(await recoverExpiredGenerationJobs(db, clock)).toHaveLength(100);
    expect(await recoverExpiredGenerationJobs(db, clock)).toHaveLength(1);
    expect(await recoverExpiredGenerationJobs(db, clock)).toHaveLength(0);
    expect(await db.select().from(auditEvents)).toHaveLength(101);
  });

  it("履歴保存が失敗した回復はロールバックし、次回の回復を妨げない", async () => {
    const { db } = testDb;
    const [row] = await db
      .insert(generationJobs)
      .values({
        idempotencyKey: "rollback",
        purpose: "faq",
        generator: "mock",
        promptVersion: "test",
        leaseUntil: clock.now(),
      })
      .returning();
    await db.execute(
      sql`CREATE FUNCTION reject_recovery_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER reject_recovery_event BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_recovery_event()`,
    );
    await expect(recoverExpiredGenerationJobs(db, clock)).rejects.toThrow();
    expect(await db.select().from(generationJobs)).toEqual([row]);
    await db.execute(sql`DROP TRIGGER reject_recovery_event ON audit_events`);
    expect(await recoverExpiredGenerationJobs(db, clock)).toEqual([row!.id]);
  });
});
