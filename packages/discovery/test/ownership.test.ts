import { fixedClock, ok } from "@siteoffer/core";
import { auditEvents, companies, type Db, discoveryJobs } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FixtureProvider } from "../src/providers/fixture.ts";
import type { DiscoveryProvider } from "../src/providers/types.ts";
import { createDiscoveryJob, runDiscovery } from "../src/run.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-19T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function job() {
  const result = await createDiscoveryJob(db, clock, { provider: "fixture", criteria: {} });
  if (!result.ok) throw Error(result.error);
  return result.value.jobId;
}

it("simultaneous starts claim the same discovery job once before calling its provider", async () => {
  const id = await job();
  let calls = 0;
  const provider: DiscoveryProvider = {
    name: "fixture",
    discover: async () => {
      calls++;
      return ok([]);
    },
  };
  const results = await Promise.all([
    runDiscovery(db, clock, id, { companies: provider }),
    runDiscovery(db, clock, id, { companies: provider }),
  ]);
  expect(calls).toBe(1);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toMatchObject({ ok: false, error: "job_already_running" });
  expect((await db.select().from(discoveryJobs))[0]).toMatchObject({ status: "succeeded", attempts: 1 });
  const events = await db.select().from(auditEvents).where(eq(auditEvents.targetId, id));
  expect(events.filter((event) => event.action === "discovery.job_started")).toHaveLength(1);
  expect(events.filter((event) => event.action === "discovery.job_succeeded")).toHaveLength(1);
});

it("a replaced attempt cannot save a late provider response or overwrite its replacement's result", async () => {
  const id = await job(),
    entered = deferred(),
    release = deferred();
  const fixture = await new FixtureProvider().discover({}, { clock });
  if (!fixture.ok) throw Error(fixture.error);
  const first = runDiscovery(db, clock, id, {
    companies: {
      name: "fixture",
      discover: async () => {
        entered.resolve();
        await release.promise;
        return ok(fixture.value.slice(0, 1));
      },
    },
  });
  try {
    await entered.promise;
    await db.update(discoveryJobs).set({ status: "failed", error: "interrupted" }).where(eq(discoveryJobs.id, id));
    expect(
      await runDiscovery(db, clock, id, { companies: { name: "fixture", discover: async () => ok([]) } }),
    ).toMatchObject({ ok: true });
  } finally {
    release.resolve();
  }
  expect(await first).toMatchObject({ ok: false, error: "job_superseded" });
  expect(await db.select().from(companies)).toHaveLength(0);
  expect((await db.select().from(discoveryJobs))[0]).toMatchObject({
    status: "succeeded",
    attempts: 2,
    foundCount: 0,
    error: null,
  });
  expect(
    (await db.select().from(auditEvents)).filter((event) => event.action === "discovery.job_succeeded"),
  ).toHaveLength(1);
});

it("a stopped attempt with the same attempt number cannot change the operator's recorded result", async () => {
  const id = await job(),
    entered = deferred(),
    release = deferred();
  const first = runDiscovery(db, clock, id, {
    companies: {
      name: "fixture",
      discover: async () => {
        entered.resolve();
        await release.promise;
        return ok([]);
      },
    },
  });
  await entered.promise;
  try {
    await db
      .update(discoveryJobs)
      .set({ status: "failed", error: "operator stop", finishedAt: clock.now() })
      .where(eq(discoveryJobs.id, id));
  } finally {
    release.resolve();
  }
  expect(await first).toMatchObject({ ok: false, error: "job_superseded" });
  expect((await db.select().from(discoveryJobs))[0]).toMatchObject({
    status: "failed",
    attempts: 1,
    error: "operator stop",
  });
});
