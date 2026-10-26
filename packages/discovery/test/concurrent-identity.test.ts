import { fixedClock, ok } from "@siteoffer/core";
import { companies, type Db, discoveryJobs, discoverySources, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FixtureProvider } from "../src/providers/fixture.ts";
import { createDiscoveryJob, runDiscovery } from "../src/run.ts";
import type { CompanyCandidate } from "../src/schemas.ts";

let db: Db, close: () => Promise<void>, candidate: CompanyCandidate;
const clock = fixedClock("2026-10-19T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const result = await new FixtureProvider().discover({}, { clock });
  if (!result.ok) throw Error(result.error);
  candidate = result.value[0]!;
});
afterEach(async () => {
  await close();
});

async function job(source: CompanyCandidate) {
  const result = await createDiscoveryJob(db, clock, { provider: source.provider, criteria: {} });
  if (!result.ok) throw Error(result.error);
  return result.value.jobId;
}
function site(source: CompanyCandidate) {
  return {
    provider: "test-search",
    externalId: "https://shared.example.test/",
    url: "https://shared.example.test/",
    title: source.name,
    sourceUrl: "https://search.example.test/",
    fetchedAt: clock.now(),
    thirdParty: false,
    evidence: {
      companyName: source.name,
      address: `${source.prefecture}${source.city}`,
      corporateNumber: source.corporateNumber,
    },
  };
}
it.each(["source", "corporate", "site"] as const)(
  "parallel jobs share one company identified by %s",
  async (identity) => {
    const sources = Array.from({ length: 4 }, (_, index) => ({
      ...candidate,
      corporateNumber: identity === "corporate" ? candidate.corporateNumber : null,
      provider: identity === "source" ? "same-source" : `source-${index}`,
      externalId: identity === "source" ? "same-external-id" : `external-${index}`,
    }));
    const ids = await Promise.all(sources.map(job));
    let entered = 0,
      release!: () => void;
    const barrier = new Promise<void>((done) => {
      release = done;
    });
    const results = await Promise.all(
      sources.map((source, index) =>
        runDiscovery(db, clock, ids[index]!, {
          companies: { name: source.provider, discover: async () => ok([source]) },
          search: {
            name: "test-search",
            findOfficialSite: async () => {
              if (++entered === sources.length) release();
              await barrier;
              return ok(identity === "site" ? [site(source)] : []);
            },
          },
        }),
      ),
    );
    expect(
      results.every((result) => result.ok && result.value.status === "succeeded" && result.value.failed === 0),
    ).toBe(true);
    expect(results.filter((result) => result.ok && result.value.created === 1)).toHaveLength(1);
    const saved = await db.select().from(companies);
    expect(saved).toHaveLength(1);
    const provenance = await db.select().from(discoverySources);
    expect(provenance.every((source) => source.companyId === saved[0]!.id)).toBe(true);
    expect((await db.select().from(websites)).length).toBe(identity === "site" ? 1 : 0);
  },
);

it("a source linked to a different corporate number cannot change that company or its provenance", async () => {
  const source = { ...candidate, corporateNumber: "8180009990999" };
  const [owner] = await db
    .insert(companies)
    .values({ name: "既存の別法人", corporateNumber: candidate.corporateNumber, officialSiteStatus: "confirmed" })
    .returning();
  const oldJob = await job(source);
  const [original] = await db
    .insert(discoverySources)
    .values({
      jobId: oldJob,
      companyId: owner!.id,
      provider: source.provider,
      externalId: source.externalId,
      role: "company",
      fetchedAt: clock.now(),
      sourceUrl: "https://original.example.test/",
    })
    .returning();
  const id = await job(source);
  let searches = 0;
  const result = await runDiscovery(db, clock, id, {
    companies: { name: source.provider, discover: async () => ok([source]) },
    search: {
      name: "test-search",
      findOfficialSite: async () => {
        searches++;
        return ok([site(source)]);
      },
    },
  });
  expect(result).toMatchObject({
    ok: true,
    value: {
      updated: 0,
      created: 0,
      skipped: 1,
      failed: 0,
      failures: [expect.objectContaining({ stage: "candidate", reason: expect.stringContaining("identity_conflict") })],
    },
  });
  expect(searches).toBe(0);
  expect(await db.select().from(companies)).toEqual([owner]);
  expect(await db.select().from(discoverySources)).toEqual([original]);
});

it("different corporate numbers remain separate even when search proposes the same site", async () => {
  const sources = [
    candidate,
    { ...candidate, provider: "another-source", externalId: "another-id", corporateNumber: "8180009990999" },
  ];
  for (const source of sources) {
    const result = await runDiscovery(db, clock, await job(source), {
      companies: { name: source.provider, discover: async () => ok([source]) },
      search: { name: "test-search", findOfficialSite: async () => ok([site(source)]) },
    });
    expect(result).toMatchObject({ ok: true, value: { status: "succeeded", created: 1, failed: 0 } });
  }
  expect(await db.select().from(companies)).toHaveLength(2);
  const savedSites = await db.select().from(websites);
  expect(savedSites).toHaveLength(1);
  const saved = await db.select().from(companies);
  expect(saved.find((row) => row.id !== savedSites[0]!.companyId)?.officialSiteStatus).toBe("needs_review");
  expect((await db.select().from(discoveryJobs)).every((row) => row.status === "succeeded")).toBe(true);
});
