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
it("search capabilities distinguish configured, disabled, legacy and inconsistent workers without a connectivity claim", async () => {
  e.deps.discovery.search = { name: "tavily", findOfficialSite: async () => ({ ok: true, value: [] }) };
  e.deps.discovery.searchLimit = 2;
  const stop = await startWorkerHeartbeat(e.deps, "standard");
  try {
    let statuses = await discoveryAvailability(e.db, e.clock);
    expect(statuses[0]?.search).toContain("最大2回");
    expect(statuses[0]?.search).toContain("接続・残高は未確認");
    const [row] = await e.db.select().from(workerRuntimes);
    const legacy = { ...row!.capabilities! };
    delete legacy.siteSearch;
    await e.db.update(workerRuntimes).set({ capabilities: legacy }).where(eq(workerRuntimes.id, row!.id));
    statuses = await discoveryAvailability(e.db, e.clock);
    expect(statuses[0]?.search).toContain("確認できません");
    await e.db
      .update(workerRuntimes)
      .set({ capabilities: { ...legacy, siteSearch: { provider: "none", maxPerRun: 2 } } })
      .where(eq(workerRuntimes.id, row!.id));
    expect((await discoveryAvailability(e.db, e.clock))[0]?.search).toContain("サイト検索は無効");
    await e.db.insert(workerRuntimes).values({
      ...row!,
      id: crypto.randomUUID(),
      capabilities: { ...legacy, siteSearch: { provider: "tavily", maxPerRun: 2 } },
    });
    expect((await discoveryAvailability(e.db, e.clock))[0]?.search).toContain("設定が異なります");
  } finally {
    await stop();
  }
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

it("heartbeat reports intake progress independently of process liveness", async () => {
  const stop = await startWorkerHeartbeat(e.deps, "demo", 5000);
  try {
    await stop.report("discovery", "dispatch");
    await stop.report("images", "images");
    await stop.report("deliveries", "deliveries");
    const [working] = await e.db.select().from(workerRuntimes);
    expect(working?.capabilities).toMatchObject({
      version: 1,
      discoveryOnly: false,
      generator: "mock",
      intakeIntervalMs: 5000,
    });
    expect(working?.progress).toMatchObject({ phase: "discovery", completedAt: null });
    await stop.report("idle", "dispatch");
    expect((await e.db.select().from(workerRuntimes))[0]?.progress).toMatchObject({
      phase: "images",
      lanes: { dispatch: { phase: "idle" }, images: { phase: "images" }, deliveries: { phase: "deliveries" } },
    });
    await stop.report("error", "images");
    expect((await e.db.select().from(workerRuntimes))[0]?.progress?.lastErrorAt).toBe(e.clock.now().toISOString());
    await stop.report("idle", "images");
    await stop.report("idle", "deliveries");
    expect((await e.db.select().from(workerRuntimes))[0]?.progress).toMatchObject({
      phase: "idle",
      completedAt: e.clock.now().toISOString(),
    });
  } finally {
    await stop();
  }
  await stop.report("images", "images");
  expect(await e.db.select().from(workerRuntimes)).toHaveLength(0);
});
it("intake reports actual phases and collection-only failures without advertising production", async () => {
  const phases: [string, string][] = [];
  const report = async (phase: string, lane: string) => {
    phases.push([phase, lane]);
  };
  await runIntakeOnce(e.deps, createIntakeState(), report);
  expect(phases.filter((p) => p[1] === "dispatch").map((p) => p[0])).toEqual(["designs", "discovery", "idle"]);
  expect(phases.filter((p) => p[1] === "images").map((p) => p[0])).toEqual(["images", "idle"]);
  expect(phases.filter((p) => p[1] === "deliveries").map((p) => p[0])).toEqual(["deliveries", "idle"]);
  e.deps.discoveryOnly = true;
  const stop = await startWorkerHeartbeat(e.deps, "standard");
  try {
    expect((await e.db.select().from(workerRuntimes))[0]?.capabilities).toMatchObject({
      discoveryOnly: true,
      imageConfigured: false,
    });
  } finally {
    await stop();
  }
  await job("fixture");
  e.deps.queue = {
    send: async () => {
      throw new Error("test queue failure");
    },
  };
  phases.length = 0;
  await expect(runIntakeOnce(e.deps, createIntakeState(), report)).rejects.toThrow("test queue failure");
  expect(phases).toEqual([
    ["discovery", "dispatch"],
    ["error", "dispatch"],
  ]);
});

it("収集の受付可否は画像のエラーと独立し、受付の停止を画像処理中の通知で隠さない", async () => {
  const stop = await startWorkerHeartbeat(e.deps, "demo");
  try {
    await stop.report("idle", "dispatch");
    await stop.report("error", "images");
    expect((await discoveryAvailability(e.db, e.clock))[0]?.ready).toBe(true);
    await stop.report("error", "dispatch");
    expect((await discoveryAvailability(e.db, e.clock))[0]).toMatchObject({
      ready: false,
      reason: expect.stringContaining("受付エラー"),
    });
    await stop.report("idle", "dispatch");
    e.clock.advance(61_000);
    await stop.report("images", "images");
    expect((await discoveryAvailability(e.db, e.clock))[0]?.ready).toBe(false);
    await stop.report("idle", "dispatch");
    expect((await discoveryAvailability(e.db, e.clock))[0]?.ready).toBe(true);
  } finally {
    await stop();
  }
});
