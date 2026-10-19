import { ok } from "@siteoffer/core";
import { auditEvents, companies, discoveryJobs } from "@siteoffer/db";
import { createDiscoveryJob, FixtureProvider } from "@siteoffer/discovery";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { executeStep } from "../src/execute.ts";
import { discoveryStep } from "../src/pipeline/discovery.ts";
import { deferred, setupEnv, type TestEnv } from "./helpers.ts";

let e: TestEnv;
beforeEach(async () => {
  e = await setupEnv({ policies: { discovery: { timeoutMs: 60000, maxAttempts: 3 } } });
});
afterEach(async () => {
  await e.cleanup();
});

it.each(["provider", "search"] as const)(
  "a worker replaced during %s cannot write late discovery data or completion",
  async (stage) => {
    const created = await createDiscoveryJob(e.db, e.clock, { provider: "fixture", criteria: {} });
    if (!created.ok) throw Error(created.error);
    const id = created.value.jobId,
      entered = deferred(),
      release = deferred();
    const fixture = await new FixtureProvider().discover({}, { clock: e.clock });
    if (!fixture.ok) throw Error(fixture.error);
    let calls = 0;
    e.deps.discoveryOnly = true;
    e.deps.discovery.providers.fixture = {
      name: "fixture",
      discover: async () => {
        const call = ++calls;
        if (stage === "provider" && call === 1) {
          entered.resolve();
          await release.promise;
        }
        return ok(
          stage === "provider" && call > 1
            ? []
            : [{ ...fixture.value[0]!, name: call === 1 ? "架空の旧応答" : "架空の新応答" }],
        );
      },
    };
    let searches = 0;
    e.deps.discovery.search = {
      name: "test-search",
      findOfficialSite: async () => {
        if (stage === "search" && ++searches === 1) {
          entered.resolve();
          await release.promise;
        }
        return ok([]);
      },
    };
    const payload = { discoveryJobId: id };
    const first = executeStep(e.deps, discoveryStep, payload);
    try {
      await entered.promise;
      e.clock.advance(60001);
      expect(await executeStep(e.deps, discoveryStep, payload)).toMatchObject({ status: "succeeded", attempt: 2 });
    } finally {
      release.resolve();
    }
    expect(await first).toMatchObject({ status: "superseded", attempt: 1 });
    const rows = await e.db.select().from(companies);
    expect(rows.map((row) => row.name)).toEqual(stage === "provider" ? [] : ["架空の新応答"]);
    expect((await e.db.select().from(discoveryJobs))[0]).toMatchObject({
      status: "succeeded",
      attempts: 2,
      foundCount: stage === "provider" ? 0 : 1,
      failedCount: 0,
    });
    const events = await e.db.select().from(auditEvents).where(eq(auditEvents.targetId, id));
    expect(events.filter((event) => event.action === "discovery.job_succeeded")).toHaveLength(1);
  },
);
