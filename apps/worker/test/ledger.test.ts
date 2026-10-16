import { type Actor, fixedClock } from "@siteoffer/core";
import { auditEvents, type Db } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger, type WorkerDeps } from "../src/deps.ts";
import { executeStep, PermanentError, type StepDefinition } from "../src/execute.ts";
import { claimStep, finishStep, foldStepEvents, readStepState, STEP_ACTIONS } from "../src/ledger.ts";
import { DEFAULT_POLICIES } from "../src/queues.ts";

const actor: Actor = { kind: "system", job: "ledger-test" };
let db: Db;
let close: () => Promise<void>;
let clock: ReturnType<typeof fixedClock>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = fixedClock("2026-10-17T00:00:00Z");
});
afterEach(async () => close());
const input = { key: "ledger:test", queue: "test", actor, maxAttempts: 3, staleAfterMs: 60_000 };

describe("試行ごとの終了記録", () => {
  it("重複と古い成功は新しい実行を終了させず、順序にも依存しない", () => {
    const event = (action: string, attempt: number, ms: number) => ({
      action,
      after: { attempt },
      createdAt: new Date(ms),
    });
    const rows = [
      event(STEP_ACTIONS.started, 1, 0),
      event(STEP_ACTIONS.failed, 1, 60),
      event(STEP_ACTIONS.started, 2, 60),
      event(STEP_ACTIONS.started, 2, 61),
      event(STEP_ACTIONS.succeeded, 1, 70),
      event(STEP_ACTIONS.succeeded, 99, 80),
    ];
    const expected = { attempts: 2, running: true, succeeded: false, gaveUp: false, lastStartedAt: new Date(60) };
    expect(foldStepEvents(rows)).toMatchObject(expected);
    expect(foldStepEvents([...rows].reverse())).toMatchObject(expected);
  });

  it("期限切れ試行の遅い成功・失敗を拒否し、現試行だけ一度終了する", async () => {
    expect(await claimStep(db, clock, input)).toMatchObject({ attempt: 1 });
    clock.advance(60_001);
    expect(await claimStep(db, clock, input)).toMatchObject({ attempt: 2, recoveredStale: true });
    expect(await finishStep(db, clock, { ...input, attempt: 1, outcome: { ok: true } })).toBe(false);
    expect(
      await finishStep(db, clock, { ...input, attempt: 1, outcome: { ok: false, reason: "late", final: true } }),
    ).toBe(false);
    expect(await readStepState(db, input.key)).toMatchObject({ attempts: 2, running: true });
    const results = await Promise.all([
      finishStep(db, clock, { ...input, attempt: 2, outcome: { ok: true } }),
      finishStep(db, clock, { ...input, attempt: 2, outcome: { ok: false, reason: "duplicate", final: true } }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await db.select().from(auditEvents);
    expect(
      rows.filter((r) => r.action !== STEP_ACTIONS.started && (r.after as { attempt: number }).attempt === 2),
    ).toHaveLength(1);
    expect(await readStepState(db, input.key)).toMatchObject({ attempts: 2, running: false });
  });

  it.each([false, true])("古い実行の終了は後始末を呼ばず superseded になる（失敗=%s）", async (fails) => {
    let release!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onGiveUp = vi.fn();
    const def: StepDefinition<null, string> = {
      kind: "audit",
      queue: input.queue,
      key: () => input.key,
      onGiveUp,
      async run(_deps, _payload, ctx) {
        if (ctx.attempt === 1) {
          ready();
          await gate;
          if (fails) throw new PermanentError("late");
        }
        return "done";
      },
    };
    const deps = {
      db,
      clock,
      logger: silentLogger,
      policies: { ...DEFAULT_POLICIES, audit: { ...DEFAULT_POLICIES.audit, timeoutMs: 60_000 } },
    } as unknown as WorkerDeps; // この試験の run はDB・clock・policies以外の依存を使わない
    const old = executeStep(deps, def, null);
    try {
      await started;
      clock.advance(60_001);
      expect(await executeStep(deps, def, null)).toMatchObject({ status: "succeeded", attempt: 2 });
      release();
      expect(await old).toMatchObject({ status: "superseded", attempt: 1 });
      expect(onGiveUp).not.toHaveBeenCalled();
      expect(await readStepState(db, input.key)).toMatchObject({ attempts: 2, succeeded: true, gaveUp: false });
    } finally {
      release();
      await old;
    }
  });
});
