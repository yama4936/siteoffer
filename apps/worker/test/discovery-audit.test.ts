import { randomUUID } from "node:crypto";
import { ok } from "@siteoffer/core";
import { auditRequests, companies, discoveryJobs, proposalHandoffs, siteAudits, websites } from "@siteoffer/db";
import { createDiscoveryJob, FixtureProvider, runDiscovery } from "@siteoffer/discovery";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpsUser } from "../../../packages/core/src/assignment/test-helpers.ts";
import { setOfficialSiteStatus } from "../../web/lib/ops/commands.ts";
import { auditRequestPayload, requestAuditByOps } from "../src/audit-request.ts";
import { executeStep } from "../src/execute.ts";
import { auditStep } from "../src/pipeline/audit.ts";
import { advanceConfirmedCompanies, discoveryStep } from "../src/pipeline/discovery.ts";
import { type AuditPayload, QUEUES } from "../src/queues.ts";
import { ONE_COMPANY_CRITERIA, setupEnv, type TestEnv } from "./helpers.ts";

let e: TestEnv;
beforeEach(async () => {
  e = await setupEnv({ threshold: 100 });
});
afterEach(async () => {
  await e.cleanup();
});
const auditMessages = () => e.queue.sent.filter((message) => message.name === QUEUES.audit);
async function collect(provider = "fixture") {
  const job = await createDiscoveryJob(e.db, e.clock, { provider, criteria: ONE_COMPANY_CRITERIA });
  if (!job.ok) throw Error(job.error);
  return { id: job.value.jobId, result: await executeStep(e.deps, discoveryStep, { discoveryJobId: job.value.jobId }) };
}
async function firstAudit() {
  const job = await collect();
  expect(job.result.status).toBe("succeeded");
  return { ...job, payload: auditMessages()[0]!.data as AuditPayload };
}

it("different discovery jobs for one company and site perform one diagnosis and proposal handoff", async () => {
  const fixture = await new FixtureProvider().discover(ONE_COMPANY_CRITERIA, { clock: e.clock });
  if (!fixture.ok) throw Error(fixture.error);
  const names = Array.from({ length: 6 }, (_, index) => `source-${index}`);
  for (const provider of names)
    e.deps.discovery.providers[provider] = {
      name: provider,
      discover: async () => ok([{ ...fixture.value[0]!, provider, externalId: provider }]),
    };
  const jobs = await Promise.all(names.map(collect));
  expect(jobs.every((job) => job.result.status === "succeeded")).toBe(true);
  const messages = auditMessages();
  for (const message of messages) await executeStep(e.deps, auditStep, message.data as AuditPayload);
  expect(await e.db.select().from(companies)).toHaveLength(1);
  expect(await e.db.select().from(siteAudits)).toHaveLength(1);
  expect(await e.db.select().from(proposalHandoffs)).toHaveLength(1);
  expect(new Set(messages.map((message) => message.singletonKey)).size).toBe(1);
}, 60000);

it("explicit distinct diagnosis requests remain distinct", async () => {
  const { payload } = await firstAudit();
  for (const requestKey of ["manual-1", "manual-2"])
    expect((await executeStep(e.deps, auditStep, { ...payload, requestKey })).status).toBe("succeeded");
  expect(await e.db.select().from(siteAudits)).toHaveLength(2);
});

it("a queued automatic diagnosis cannot silently use a different primary site", async () => {
  const { id, payload } = await firstAudit(),
    { actor } = await createOpsUser(e.db);
  const [replacement] = await e.db
    .insert(websites)
    .values({
      companyId: payload.companyId,
      url: "https://replacement.example.test/",
      normalizedUrl: "https://replacement.example.test",
      domain: "replacement.example.test",
      kind: "current",
    })
    .returning();
  expect(
    (
      await setOfficialSiteStatus({ db: e.db, clock: e.clock }, actor, {
        companyId: payload.companyId,
        status: "confirmed",
        websiteId: replacement!.id,
      })
    ).ok,
  ).toBe(true);
  expect((await executeStep(e.deps, auditStep, payload)).status).toBe("failed");
  expect(await e.db.select().from(siteAudits)).toHaveLength(0);
  await advanceConfirmedCompanies(e.deps, id);
  const next = auditMessages().at(-1)!.data as AuditPayload;
  expect(next.requestKey).not.toBe(payload.requestKey);
  expect((await executeStep(e.deps, auditStep, next)).status).toBe("succeeded");
  expect((await e.db.select().from(siteAudits))[0]?.websiteId).toBe(replacement!.id);
});

it("the same website row with a replaced URL requires a new automatic target key", async () => {
  const { id, payload } = await firstAudit();
  const [site] = await e.db.select().from(websites).where(eq(websites.companyId, payload.companyId));
  await e.db
    .update(websites)
    .set({
      url: "https://changed.example.test/",
      normalizedUrl: "https://changed.example.test",
      domain: "changed.example.test",
    })
    .where(eq(websites.id, site!.id));
  expect((await executeStep(e.deps, auditStep, payload)).status).toBe("failed");
  expect(await e.db.select().from(siteAudits)).toHaveLength(0);
  await advanceConfirmedCompanies(e.deps, id);
  const next = auditMessages().at(-1)!.data as AuditPayload;
  expect(next.requestKey).not.toBe(payload.requestKey);
  expect((await executeStep(e.deps, auditStep, next)).status).toBe("succeeded");
  expect((await e.db.select().from(siteAudits))[0]?.targetUrl).toBe("https://changed.example.test/");
});

it("lost send acknowledgement reuses the automatic target without recollecting", async () => {
  const send = e.deps.queue.send.bind(e.deps.queue);
  let lost = false;
  e.deps.queue = {
    send: async (name, data, options) => {
      await send(name, data, options);
      if (name === QUEUES.audit && !lost) {
        lost = true;
        throw Error("injected acknowledgement loss");
      }
    },
  };
  const first = await collect();
  expect(first.result.status).toBe("retry");
  expect((await executeStep(e.deps, discoveryStep, { discoveryJobId: first.id })).status).toBe("succeeded");
  const messages = auditMessages();
  expect(messages).toHaveLength(2);
  expect(new Set(messages.map((message) => message.singletonKey)).size).toBe(1);
  expect(e.queue.size).toBe(1);
  expect((await e.db.select().from(discoveryJobs))[0]?.attempts).toBe(1);
  for (const message of messages) await executeStep(e.deps, auditStep, message.data as AuditPayload);
  expect(await e.db.select().from(siteAudits)).toHaveLength(1);
});

it("another completed diagnosis prevents a queued automatic initial diagnosis from scoring again", async () => {
  const { payload } = await firstAudit();
  expect((await executeStep(e.deps, auditStep, { ...payload, requestKey: "manual-existing" })).status).toBe(
    "succeeded",
  );
  const [before] = await e.db.select().from(companies).where(eq(companies.id, payload.companyId));
  expect((await executeStep(e.deps, auditStep, payload)).status).toBe("failed");
  expect(await e.db.select().from(siteAudits)).toHaveLength(1);
  expect((await e.db.select().from(companies)).find((row) => row.id === before!.id)).toEqual(before);
});

it("own saved diagnosis and handoff survive a completion acknowledgement failure", async () => {
  const { payload } = await firstAudit();
  let lost = false;
  const step = {
    ...auditStep,
    run: async (...args: Parameters<typeof auditStep.run>) => {
      const result = await auditStep.run(...args);
      if (!lost) {
        lost = true;
        throw Error("injected completion acknowledgement loss");
      }
      return result;
    },
  };
  expect((await executeStep(e.deps, step, payload)).status).toBe("retry");
  expect((await executeStep(e.deps, step, payload)).status).toBe("succeeded");
  expect(await e.db.select().from(siteAudits)).toHaveLength(1);
  expect(await e.db.select().from(proposalHandoffs)).toHaveLength(1);
});

it("an initial automatic request cannot score after the company has advanced to review", async () => {
  const { payload } = await firstAudit();
  await e.db.update(companies).set({ pipelineStatus: "in_review" }).where(eq(companies.id, payload.companyId));
  expect((await executeStep(e.deps, auditStep, payload)).status).toBe("failed");
  expect(await e.db.select().from(siteAudits)).toHaveLength(0);
  expect((await e.db.select().from(companies))[0]?.pipelineStatus).toBe("in_review");
});

async function busyPreviousTarget() {
  const { id, payload } = await firstAudit(),
    { actor } = await createOpsUser(e.db);
  const [oldSite] = await e.db.select().from(websites).where(eq(websites.companyId, payload.companyId));
  const [nextSite] = await e.db
    .insert(websites)
    .values({
      companyId: payload.companyId,
      url: "https://next-target.example.test/",
      normalizedUrl: "https://next-target.example.test",
      domain: "next-target.example.test",
      kind: "current",
    })
    .returning();
  expect(
    (
      await setOfficialSiteStatus({ db: e.db, clock: e.clock }, actor, {
        companyId: payload.companyId,
        status: "confirmed",
        websiteId: nextSite!.id,
      })
    ).ok,
  ).toBe(true);
  const [active] = await e.db
    .insert(siteAudits)
    .values({
      companyId: payload.companyId,
      websiteId: oldSite!.id,
      targetUrl: oldSite!.url,
      status: "collecting",
      artifactDir: e.dir,
    })
    .returning();
  await advanceConfirmedCompanies(e.deps, id);
  return { active: active!, nextSite: nextSite!, payload: auditMessages().at(-1)!.data as AuditPayload };
}

it("a replacement target waits for the earlier diagnosis and resumes automatically without overlapping calls", async () => {
  const { active, nextSite, payload } = await busyPreviousTarget();
  expect((await executeStep(e.deps, auditStep, payload)).status).toBe("retry");
  expect(await e.db.select().from(siteAudits)).toHaveLength(1);
  await e.db.update(siteAudits).set({ status: "failed" }).where(eq(siteAudits.id, active.id));
  expect((await executeStep(e.deps, auditStep, payload)).status).toBe("succeeded");
  const rows = await e.db.select().from(siteAudits);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.websiteId === nextSite.id)?.status).toBe("evaluated");
  expect(rows.find((row) => row.id === active.id)?.status).toBe("failed");
});

it("a busy automatic request stops at its retry limit without failing the company or the other diagnosis", async () => {
  const { active, payload } = await busyPreviousTarget();
  e.deps.policies = { ...e.deps.policies, audit: { ...e.deps.policies.audit, maxAttempts: 1 } };
  expect((await executeStep(e.deps, auditStep, payload)).status).toBe("failed");
  expect(await e.db.select().from(siteAudits)).toEqual([active]);
  expect((await e.db.select().from(companies))[0]?.pipelineStatus).toBe("site_confirmed");
});

async function pendingOperatorRequest() {
  const created = await createDiscoveryJob(e.db, e.clock, { provider: "fixture", criteria: ONE_COMPANY_CRITERIA });
  if (!created.ok) throw Error(created.error);
  const result = await runDiscovery(e.db, e.clock, created.value.jobId, {
    companies: e.deps.discovery.providers.fixture!,
    search: e.deps.discovery.search,
  });
  if (!result.ok) throw Error(result.error);
  const [company] = await e.db.select().from(companies),
    { actor } = await createOpsUser(e.db);
  const accepted = await requestAuditByOps(e.db, e.clock, actor, { companyId: company!.id, requestId: randomUUID() });
  if (!accepted.ok) throw Error(accepted.error);
  return {
    id: created.value.jobId,
    company: company!,
    actor,
    payload: auditRequestPayload({ companyId: company!.id, id: accepted.value.requestId }),
  };
}

it("an already accepted operator request has priority over automatic discovery for the same target", async () => {
  const pending = await pendingOperatorRequest();
  await advanceConfirmedCompanies(e.deps, pending.id);
  expect((await e.runtime.run(QUEUES.audit, auditMessages().at(-1)!.data)).status).toBe("failed");
  expect(await e.db.select().from(siteAudits)).toHaveLength(0);
  expect((await e.runtime.run(QUEUES.audit, pending.payload)).status).toBe("succeeded");
  expect(await e.db.select().from(siteAudits)).toHaveLength(1);
  expect(await e.db.select().from(proposalHandoffs)).toHaveLength(1);
  expect((await e.db.select().from(auditRequests))[0]?.status).toBe("completed");
});

it("an operator request for a replaced target does not block the new automatic target", async () => {
  const pending = await pendingOperatorRequest();
  const [site] = await e.db
    .insert(websites)
    .values({
      companyId: pending.company.id,
      url: "https://current-target.example.test/",
      normalizedUrl: "https://current-target.example.test",
      domain: "current-target.example.test",
      kind: "current",
    })
    .returning();
  expect(
    (
      await setOfficialSiteStatus({ db: e.db, clock: e.clock }, pending.actor, {
        companyId: pending.company.id,
        status: "confirmed",
        websiteId: site!.id,
      })
    ).ok,
  ).toBe(true);
  await advanceConfirmedCompanies(e.deps, pending.id);
  expect((await e.runtime.run(QUEUES.audit, auditMessages().at(-1)!.data)).status).toBe("succeeded");
  expect((await e.runtime.run(QUEUES.audit, pending.payload)).status).toBe("failed");
  const audits = await e.db.select().from(siteAudits);
  expect(audits).toHaveLength(1);
  expect(audits[0]?.websiteId).toBe(site!.id);
  expect((await e.db.select().from(auditRequests))[0]?.status).toBe("failed");
});
