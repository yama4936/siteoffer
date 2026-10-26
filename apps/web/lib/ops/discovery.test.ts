import { randomUUID } from "node:crypto";
import { fixedClock, recordEvent } from "@siteoffer/core";
import { type Db, discoveryJobs, workerRuntimes } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { createDiscoveryJob, discoveryAvailability } from "@siteoffer/discovery";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscoveryJobByOps, retryDiscoveryJobByOps } from "./commands";
import { seedUser } from "./test-seed";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-16T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
async function heartbeat(providers = ["fixture"], age = 0) {
  await db
    .insert(workerRuntimes)
    .values({ id: randomUUID(), mode: "demo", providers, heartbeatAt: new Date(clock.now().getTime() - age) });
}
it("offline, stale, unsupported and mixed workers cannot accept a job", async () => {
  const { actor } = await seedUser(db, "ops");
  const input = { provider: "fixture", criteria: { prefecture: "愛知県" } };
  expect(await createDiscoveryJobByOps({ db, clock }, actor, input)).toMatchObject({
    ok: false,
    error: "provider_unavailable",
  });
  await heartbeat(["fixture"], 46000);
  expect((await discoveryAvailability(db, clock))[0]?.ready).toBe(false);
  await heartbeat();
  expect((await createDiscoveryJobByOps({ db, clock }, actor, input)).ok).toBe(true);
  expect(
    await createDiscoveryJobByOps({ db, clock }, actor, { ...input, provider: "nta-corporate-number" }),
  ).toMatchObject({ ok: false, error: "provider_unavailable" });
  await heartbeat(["nta-corporate-number"]);
  expect((await discoveryAvailability(db, clock)).every((p) => !p.ready)).toBe(true);
});
it("retry preserves failed history, uses a new id and is idempotent", async () => {
  const { actor } = await seedUser(db, "ops");
  await heartbeat();
  const original = await createDiscoveryJob(db, clock, { provider: "fixture", criteria: { prefecture: "愛知県" } });
  if (!original.ok) throw new Error("seed");
  const id = original.value.jobId;
  expect(await retryDiscoveryJobByOps({ db, clock }, actor, id)).toMatchObject({ ok: false, error: "invalid_state" });
  await db.update(discoveryJobs).set({ status: "failed", error: "original failure" }).where(eq(discoveryJobs.id, id));
  const a = await retryDiscoveryJobByOps({ db, clock }, actor, id);
  const b = await retryDiscoveryJobByOps({ db, clock }, actor, id);
  expect(a.ok).toBe(true);
  expect(b).toEqual(a);
  if (!a.ok) throw new Error("retry");
  expect(a.value.jobId).not.toBe(id);
  const rows = await db.select().from(discoveryJobs);
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.id === id)).toMatchObject({ status: "failed", error: "original failure" });
  expect(rows.find((r) => r.id === a.value.jobId)).toMatchObject({ status: "queued", retryOfJobId: id });
  expect(await retryDiscoveryJobByOps({ db, clock }, null, id)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await retryDiscoveryJobByOps({ db, clock }, actor, "------------------------------------")).toMatchObject({
    ok: false,
    error: "not_found",
  });
});
it("retry remains blocked until the provider is available", async () => {
  const { actor } = await seedUser(db, "ops");
  const r = await createDiscoveryJob(db, clock, {
    provider: "nta-corporate-number",
    criteria: { prefecture: "愛知県" },
  });
  if (!r.ok) throw new Error("seed");
  await db.update(discoveryJobs).set({ status: "failed" }).where(eq(discoveryJobs.id, r.value.jobId));
  expect(await retryDiscoveryJobByOps({ db, clock }, actor, r.value.jobId)).toMatchObject({
    ok: false,
    error: "provider_unavailable",
  });
  expect(await db.select().from(discoveryJobs)).toHaveLength(1);
  await heartbeat(["nta-corporate-number"]);
  expect((await retryDiscoveryJobByOps({ db, clock }, actor, r.value.jobId)).ok).toBe(true);
  expect(
    await createDiscoveryJobByOps({ db, clock }, actor, {
      provider: "nta-corporate-number",
      criteria: { prefecture: "愛知県", industry: "建設" },
    }),
  ).toMatchObject({ ok: false, error: "invalid_criteria" });
});

it("manual retry waits for an active attempt and retires pending automatic retries", async () => {
  const { actor } = await seedUser(db, "ops");
  await heartbeat();
  const r = await createDiscoveryJob(db, clock, { provider: "fixture", criteria: { prefecture: "愛知県" } });
  if (!r.ok) throw new Error("seed");
  const id = r.value.jobId;
  const key = `discovery:${id}`;
  await db.update(discoveryJobs).set({ status: "failed" }).where(eq(discoveryJobs.id, id));
  const event = { actor: { kind: "system" as const, job: "test" }, targetType: "worker_step", targetId: key };
  await recordEvent(db, clock, { ...event, action: "worker.step_started", after: { attempt: 1 } });
  expect(await retryDiscoveryJobByOps({ db, clock }, actor, id)).toMatchObject({ ok: false, error: "invalid_state" });
  await recordEvent(db, clock, { ...event, action: "worker.step_failed", after: { attempt: 1, final: false } });
  expect((await retryDiscoveryJobByOps({ db, clock }, actor, id)).ok).toBe(true);
  const { readStepState } = await import("../../../worker/src/ledger.ts");
  expect((await readStepState(db, key)).gaveUp).toBe(true);
});
