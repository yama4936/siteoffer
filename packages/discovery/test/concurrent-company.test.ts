import { fixedClock, ok, suppressCompany } from "@siteoffer/core";
import { companies, type Db, discoverySources, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setOfficialSiteStatus, updateCandidate } from "../../../apps/web/lib/ops/commands.ts";
import { createOpsUser } from "../../core/src/assignment/test-helpers.ts";
import { FixtureProvider } from "../src/providers/fixture.ts";
import type { SearchProvider } from "../src/providers/types.ts";
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function seed(values: Partial<typeof companies.$inferInsert> = {}) {
  const [row] = await db
    .insert(companies)
    .values({
      name: candidate.name,
      corporateNumber: candidate.corporateNumber,
      prefecture: candidate.prefecture,
      city: candidate.city,
      address: candidate.address,
      addressSourceUrl: candidate.addressSourceUrl,
      industry: candidate.industry,
      representativePhone: candidate.representativePhone,
      officialSiteStatus: "needs_review",
      ...values,
    })
    .returning();
  return row!;
}
const current = async (id: string) => (await db.select().from(companies).where(eq(companies.id, id)))[0]!;
async function waitingRun(search: SearchProvider, source = candidate) {
  const entered = deferred(),
    release = deferred();
  const job = await createDiscoveryJob(db, clock, { provider: source.provider, criteria: {} });
  if (!job.ok) throw Error(job.error);
  const running = runDiscovery(db, clock, job.value.jobId, {
    companies: { name: source.provider, discover: async () => ok([source]) },
    search: {
      name: search.name,
      findOfficialSite: async (...args) => {
        entered.resolve();
        await release.promise;
        return search.findOfficialSite(...args);
      },
    },
  });
  await entered.promise;
  return { running, release: release.resolve };
}
const noSites: SearchProvider = { name: "test-search", findOfficialSite: async () => ok([]) };
function matchingSite(source = candidate): SearchProvider {
  return {
    name: "test-search",
    findOfficialSite: async (_, { clock }) =>
      ok([
        {
          provider: "test-search",
          externalId: "https://current.example.test/",
          url: "https://current.example.test/",
          sourceUrl: "https://search.example.test/",
          title: source.name,
          fetchedAt: clock.now(),
          thirdParty: false,
          evidence: {
            companyName: source.name,
            address: `${source.prefecture}${source.city}`,
            corporateNumber: source.corporateNumber,
          },
        },
      ]),
  };
}

it.each(["do_not_contact", "excluded", "existing_customer"] as const)(
  "a %s decision during search prevents all later company and site updates",
  async (kind) => {
    const company = await seed({ name: "運営が記録した社名" }),
      { actor } = await createOpsUser(db);
    const flight = await waitingRun(matchingSite());
    let stopped: typeof company;
    try {
      const result = await suppressCompany(db, clock, actor, {
        companyId: company.id,
        kind,
        reason: "確認した最新の判断",
      });
      if (!result.ok) throw Error(result.error);
      stopped = await current(company.id);
    } finally {
      flight.release();
    }
    expect(await flight.running).toMatchObject({ ok: true, value: { created: 0, updated: 0, skipped: 1 } });
    expect(await current(company.id)).toEqual(stopped!);
    expect(await db.select().from(websites)).toHaveLength(0);
    const sources = await db.select().from(discoverySources);
    expect(sources.map((row) => row.role)).toEqual(["company"]);
  },
);

it("a completed operator edit keeps its name, complete address and contact values when old search returns", async () => {
  const company = await seed({
      name: "収集前の社名",
      address: "収集前の住所",
      addressSourceUrl: "https://before.example.test/",
      officialSiteStatus: "not_found",
    }),
    { actor } = await createOpsUser(db);
  const flight = await waitingRun(noSites);
  let edited: typeof company;
  try {
    const result = await updateCandidate({ db, clock }, actor, {
      companyId: company.id,
      patch: {
        name: "運営が訂正した社名",
        prefecture: "岐阜県",
        city: "岐阜市",
        address: "訂正した住所",
        addressSourceUrl: "https://verified.example.test/address",
        representativePhone: "09012345678",
        industry: "運営が確認した業種",
      },
    });
    if (!result.ok) throw Error(result.error);
    edited = result.value;
  } finally {
    flight.release();
  }
  expect((await flight.running).ok).toBe(true);
  expect(await current(company.id)).toEqual(edited!);
});

it("only the edited fields are retained; other missing facts still receive collected values", async () => {
  const company = await seed({ representativePhone: null, industry: null, officialSiteStatus: "not_found" }),
    { actor } = await createOpsUser(db);
  const flight = await waitingRun(noSites);
  try {
    expect(
      (
        await updateCandidate({ db, clock }, actor, {
          companyId: company.id,
          patch: { representativePhone: "09012345678" },
        })
      ).ok,
    ).toBe(true);
  } finally {
    flight.release();
  }
  expect((await flight.running).ok).toBe(true);
  expect(await current(company.id)).toMatchObject({ representativePhone: "09012345678", industry: candidate.industry });
});

it.each(["confirmed", "needs_review"] as const)(
  "an explicit %s review during search takes priority over the earlier search",
  async (status) => {
    const company = await seed({ officialSiteStatus: "candidate" }),
      { actor } = await createOpsUser(db);
    const [site] = await db
      .insert(websites)
      .values({
        companyId: company.id,
        url: "https://chosen.example.test/",
        normalizedUrl: "https://chosen.example.test/",
        domain: "chosen.example.test",
        kind: "current",
        isPrimary: true,
      })
      .returning();
    const flight = await waitingRun(status === "confirmed" ? noSites : matchingSite());
    try {
      const result = await setOfficialSiteStatus({ db, clock }, actor, {
        companyId: company.id,
        status,
        websiteId: site!.id,
        note: "運営の最新の確認",
      });
      if (!result.ok) throw Error(result.error);
    } finally {
      flight.release();
    }
    expect((await flight.running).ok).toBe(true);
    expect((await current(company.id)).officialSiteStatus).toBe(status);
    expect((await db.select().from(websites)).filter((row) => row.isPrimary).map((row) => row.id)).toEqual([site!.id]);
  },
);

it("a protected company matched only by its existing site is kept untouched", async () => {
  const source = { ...candidate, corporateNumber: null };
  const company = await seed({
    corporateNumber: null,
    name: "保存済みの企業名",
    suppression: "excluded",
    officialSiteStatus: "needs_review",
  });
  await db.insert(websites).values({
    companyId: company.id,
    url: "https://current.example.test/",
    normalizedUrl: "https://current.example.test",
    domain: "current.example.test",
    kind: "current",
    isPrimary: true,
  });
  const before = await current(company.id),
    flight = await waitingRun(matchingSite(source), source);
  flight.release();
  expect(await flight.running).toMatchObject({ ok: true, value: { updated: 0, skipped: 1 } });
  expect(await current(company.id)).toEqual(before);
});

it("a corrected name and address are used to rejudge site evidence that has no corporate number", async () => {
  const source = { ...candidate, corporateNumber: null };
  const company = await seed({ corporateNumber: null }),
    { actor } = await createOpsUser(db);
  const seedJob = await createDiscoveryJob(db, clock, { provider: source.provider, criteria: {} });
  if (!seedJob.ok) throw Error(seedJob.error);
  await db.insert(discoverySources).values({
    jobId: seedJob.value.jobId,
    companyId: company.id,
    provider: source.provider,
    externalId: source.externalId,
    role: "company",
    fetchedAt: clock.now(),
  });
  const flight = await waitingRun(matchingSite(source), source);
  try {
    expect(
      (
        await updateCandidate({ db, clock }, actor, {
          companyId: company.id,
          patch: { name: "訂正済みの別名", city: "岐阜市" },
        })
      ).ok,
    ).toBe(true);
  } finally {
    flight.release();
  }
  expect((await flight.running).ok).toBe(true);
  expect((await current(company.id)).officialSiteStatus).toBe("needs_review");
  expect(await db.select().from(websites)).toHaveLength(0);
  const evidence = (await db.select().from(discoverySources)).find((row) => row.role === "site");
  expect(evidence?.payload).toMatchObject({ verdict: "unrelated" });
});

it("a concurrent address edit keeps its entire location and source together", async () => {
  const company = await seed({ officialSiteStatus: "not_found" }),
    { actor } = await createOpsUser(db);
  const source = {
    ...candidate,
    prefecture: "三重県",
    city: "四日市市",
    address: "取得元の新しい住所",
    addressSourceUrl: "https://collected.example.test/address",
  };
  const flight = await waitingRun(noSites, source);
  try {
    expect(
      (await updateCandidate({ db, clock }, actor, { companyId: company.id, patch: { address: "運営が訂正した住所" } }))
        .ok,
    ).toBe(true);
  } finally {
    flight.release();
  }
  expect((await flight.running).ok).toBe(true);
  expect(await current(company.id)).toMatchObject({
    prefecture: company.prefecture,
    city: company.city,
    address: "運営が訂正した住所",
    addressSourceUrl: company.addressSourceUrl,
  });
});
