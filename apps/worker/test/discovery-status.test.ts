import { discoveryJobs, workerRuntimes } from "@siteoffer/db";
import { createDiscoveryJob, discoveryAvailability } from "@siteoffer/discovery";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildWorkerDeps, resolveWorkerConfig } from "../src/config.ts";
import { startWorkerHeartbeat } from "../src/heartbeat.ts";
import { createIntakeState, intakeDiscoveryJobs, runIntakeOnce } from "../src/intake.ts";
import { QUEUES } from "../src/queues.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

let e: TestEnv;
beforeEach(async () => {
  e = await setupEnv();
});
afterEach(async () => {
  await e.cleanup();
});
async function job(provider = "missing-provider") {
  const r = await createDiscoveryJob(e.db, e.clock, { provider, criteria: { prefecture: "愛知県" } });
  if (!r.ok) throw new Error("seed");
  return r.value.jobId;
}
it("unsupported jobs become failed with a visible reason instead of staying queued", async () => {
  const id = await job();
  expect(await intakeDiscoveryJobs(e.deps, createIntakeState())).toEqual([]);
  expect((await e.db.select().from(discoveryJobs).where(eq(discoveryJobs.id, id)))[0]).toMatchObject({
    status: "failed",
    error: expect.stringContaining("設定後に再試行"),
  });
});
it("direct queue execution also persists unsupported-provider failure", async () => {
  const id = await job();
  await e.runtime.run(QUEUES.discovery, { discoveryJobId: id });
  expect((await e.db.select().from(discoveryJobs).where(eq(discoveryJobs.id, id)))[0]?.status).toBe("failed");
  // Reproduce old records whose queue ledger is terminal but DB row is still queued.
  await e.db.update(discoveryJobs).set({ status: "queued", provider: "fixture" }).where(eq(discoveryJobs.id, id));
  expect(await intakeDiscoveryJobs(e.deps, createIntakeState())).toEqual([]);
  expect((await e.db.select().from(discoveryJobs).where(eq(discoveryJobs.id, id)))[0]?.status).toBe("failed");
});
it("heartbeat advertises real capabilities and is removed on shutdown", async () => {
  const stop = await startWorkerHeartbeat(e.deps, "demo");
  try {
    expect((await discoveryAvailability(e.db, e.clock))[0]?.ready).toBe(true);
    expect((await discoveryAvailability(e.db, e.clock))[1]?.ready).toBe(false);
  } finally {
    await stop();
  }
  expect(await e.db.select().from(workerRuntimes)).toHaveLength(0);
});
it("real collection has no fake search and collection-only mode queues no audit", async () => {
  const c = resolveWorkerConfig({
    SITEOFFER_DISCOVERY_PROVIDERS: "nta",
    NTA_APPLICATION_ID: "test-only",
    SITEOFFER_DISCOVERY_ONLY: "true",
  });
  if (!c.ok) throw new Error(c.message);
  const deps = buildWorkerDeps(c.value, e.deps);
  expect(deps.discovery.search).toBeUndefined();
  expect(deps.discoveryOnly).toBe(true);
  const id = await job("fixture");
  e.deps.discoveryOnly = true;
  expect((await runIntakeOnce(e.deps, createIntakeState())).discovery).toEqual([id]);
  const results = await e.queue.drain(e.runtime);
  expect(results).toHaveLength(1);
  expect(results[0]?.outcome).toMatchObject({ status: "succeeded", result: { auditQueued: [] } });
});
