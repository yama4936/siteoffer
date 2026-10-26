import { randomUUID } from "node:crypto";
import { companies, type Db, discoveryJobs, discoverySources, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readDiscoveryIndex } from "./discovery-index";
import {
  discoveryConditionText,
  discoveryIndexHref,
  discoveryIndexParams,
  parseDiscoveryIndexQuery,
} from "./discovery-index-query";
import { seedUser } from "./test-seed";

let db: Db, close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());
const query = (value: Record<string, string> = {}) => parseDiscoveryIndexQuery(value)!;
function result<T>(value: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!value.ok) throw Error(value.error);
  return value.value;
}
it("finds companies beyond the previous 200-row cutoff with literal region/name/industry queries, state filters and stable pages", async () => {
  const { actor } = await seedUser(db, "ops");
  const [target] = await db
    .insert(companies)
    .values({
      name: "探す_100%製作所",
      prefecture: "愛知県",
      city: "名古屋市中区",
      industry: "特殊印刷",
      corporateNumber: "1234567890123",
      pipelineStatus: "on_hold",
      officialSiteStatus: "needs_review",
      suppression: "do_not_contact",
      suppressionReason: "private reason",
      representativePhone: "private phone",
      updatedAt: new Date("2020-01-01"),
    })
    .returning();
  await db.insert(companies).values(
    Array.from({ length: 250 }, (_, i) => ({
      name: `他社${i}`,
      prefecture: "東京都",
      city: "新宿区",
      updatedAt: new Date("2026-10-01"),
    })),
  );
  expect(
    (await db.select({ id: companies.id }).from(companies).orderBy(desc(companies.updatedAt)).limit(200)).some(
      (row) => row.id === target!.id,
    ),
  ).toBe(false);
  const first = result(await readDiscoveryIndex(db, actor, query()));
  expect(first.companies).toMatchObject({ total: 251, page: 1, pages: 13 });
  expect(first.companies.items).toHaveLength(20);
  expect(first.companies.items[0]).not.toHaveProperty("suppressionReason");
  expect(first.companies.items[0]).not.toHaveProperty("representativePhone");
  const second = result(await readDiscoveryIndex(db, actor, query({ companyPage: "2" })));
  expect(new Set([...first.companies.items, ...second.companies.items].map((row) => row.id)).size).toBe(40);
  for (const q of ["探す_100%", "名古屋市", "特殊印刷", "1234567890123", "%", "_"]) {
    const found = result(
      await readDiscoveryIndex(
        db,
        actor,
        query({
          q,
          prefecture: "愛知県",
          city: "名古屋市",
          official: "needs_review",
          pipeline: "on_hold",
          suppressed: "yes",
        }),
      ),
    );
    expect(found.companies.items.map((row) => row.id)).toEqual([target!.id]);
  }
  const last = result(await readDiscoveryIndex(db, actor, query({ companyPage: String(Number.MAX_SAFE_INTEGER) })));
  expect(last.companies).toMatchObject({ page: 13, pages: 13 });
  expect(last.companies.items).toHaveLength(11);
  expect(last.companies.items.at(-1)?.id).toBe(target!.id);
  expect(result(await readDiscoveryIndex(db, actor, query({ city: "名古屋_" }))).companies.total).toBe(0);
  expect(result(await readDiscoveryIndex(db, actor, query({ suppressed: "no", q: "探す" }))).companies.total).toBe(0);
});
it("searches all 251 jobs while returning only 20 bounded condition summaries and failure counts", async () => {
  const { actor } = await seedUser(db, "ops");
  const [target] = await db
    .insert(discoveryJobs)
    .values({
      provider: "nta-corporate-number",
      status: "failed",
      criteria: {
        prefecture: "愛知県",
        city: "名古屋市",
        industry: "印刷_100%",
        keywords: ["春の製作所", ...Array(50).fill("x".repeat(1000))],
        limit: 50,
        unknown: "private".repeat(50000),
      },
      failures: Array(1000).fill({ reason: "private failure".repeat(500) }),
      error: "private error".repeat(10000),
      createdAt: new Date("2020-01-01"),
    })
    .returning();
  await db.insert(discoveryJobs).values(
    Array.from({ length: 250 }, () => ({
      provider: "fixture",
      criteria: { city: "東京" },
      status: "succeeded" as const,
      createdAt: new Date("2026-10-01"),
    })),
  );
  expect(
    (
      await db.select({ id: discoveryJobs.id }).from(discoveryJobs).orderBy(desc(discoveryJobs.createdAt)).limit(200)
    ).some((row) => row.id === target!.id),
  ).toBe(false);
  const first = result(await readDiscoveryIndex(db, actor, query()));
  expect(first.jobs).toMatchObject({ total: 251, page: 1, pages: 13 });
  expect(first.jobs.items).toHaveLength(20);
  for (const jobQuery of [target!.id.slice(0, 8), "名古屋市", "印刷_100%", "春の製作所", "%"]) {
    const found = result(
      await readDiscoveryIndex(
        db,
        actor,
        query({ jobQuery, jobStatus: "failed", jobProvider: "nta-corporate-number" }),
      ),
    );
    expect(found.jobs.items.map((row) => row.id)).toEqual([target!.id]);
    const row = found.jobs.items[0]!;
    expect(row).toMatchObject({ hasError: true, failureCount: 1000 });
    expect(row).not.toHaveProperty("criteria");
    expect(row).not.toHaveProperty("failures");
    expect(row).not.toHaveProperty("error");
    expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(2000);
    expect(JSON.stringify(row)).not.toContain("private");
    expect(discoveryConditionText(row.condition)).toContain("上限 50件");
  }
  const last = result(await readDiscoveryIndex(db, actor, query({ jobsPage: String(Number.MAX_SAFE_INTEGER) })));
  expect(last.jobs).toMatchObject({ page: 13, pages: 13 });
  expect(last.jobs.items).toHaveLength(11);
});
it("filters related companies without duplicate counts and represents current source associations after later collections", async () => {
  const { actor } = await seedUser(db, "ops");
  const [a, b] = await db
    .insert(companies)
    .values([{ name: "関連会社" }, { name: "別会社" }])
    .returning();
  const [job, later] = await db
    .insert(discoveryJobs)
    .values([
      { provider: "fixture", criteria: {} },
      { provider: "fixture", criteria: {} },
    ])
    .returning();
  const [source] = await db
    .insert(discoverySources)
    .values([
      {
        jobId: job!.id,
        companyId: a!.id,
        provider: "fixture",
        role: "company",
        externalId: randomUUID(),
        fetchedAt: new Date(),
      },
      {
        jobId: job!.id,
        companyId: a!.id,
        provider: "fixture",
        role: "site",
        externalId: randomUUID(),
        fetchedAt: new Date(),
      },
      { jobId: later!.id, companyId: b!.id, provider: "fixture", externalId: randomUUID(), fetchedAt: new Date() },
    ])
    .returning();
  const found = result(await readDiscoveryIndex(db, actor, query({ sourceJob: job!.id })));
  expect(found.sourceJob?.id).toBe(job!.id);
  expect(found.companies.total).toBe(1);
  expect(found.companies.items[0]?.id).toBe(a!.id);
  await db.update(discoverySources).set({ jobId: later!.id }).where(eq(discoverySources.companyId, a!.id));
  expect(result(await readDiscoveryIndex(db, actor, query({ sourceJob: job!.id }))).companies.total).toBe(0);
  expect(result(await readDiscoveryIndex(db, actor, query({ sourceJob: later!.id }))).companies.total).toBe(2);
  expect(source).toBeDefined();
  expect(await readDiscoveryIndex(db, actor, query({ sourceJob: randomUUID() }))).toEqual({
    ok: false,
    error: "not_found",
  });
});
it("requires a currently active real ops account and rejects invalid query state", async () => {
  const { actor } = await seedUser(db, "ops"),
    sales = await seedUser(db, "sales");
  for (const who of [
    null,
    sales.actor,
    { kind: "ops" as const, userId: sales.user.id },
    { kind: "ops" as const, userId: randomUUID() },
    { kind: "ops" as const, userId: "invalid" },
  ])
    expect(await readDiscoveryIndex(db, who, query())).toMatchObject({ ok: false, error: "forbidden" });
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, actor.userId));
  expect(await readDiscoveryIndex(db, actor, query())).toMatchObject({ ok: false, error: "forbidden" });
  expect(await readDiscoveryIndex(db, actor, { ...query(), jobsPage: Infinity })).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
});
it("keeps independent filters in URLs, removes defaults and rejects ambiguous or unsafe query inputs", () => {
  const value = query({
    q: "  名古屋_%  ",
    prefecture: "愛知県",
    city: "名古屋市",
    companyPage: "3",
    jobQuery: "abc",
    jobStatus: "failed",
    jobsPage: "2",
    sourceJob: randomUUID(),
  });
  expect(parseDiscoveryIndexQuery(Object.fromEntries(discoveryIndexParams(value)))).toEqual(value);
  expect(discoveryIndexHref(value)).toContain("jobsPage=2");
  expect(discoveryIndexHref(query())).toBe("/ops/discovery");
  for (const search of [
    { q: ["a", "b"] },
    { jobStatus: "cancelled" },
    { jobProvider: "unknown" },
    { official: "__proto__" },
    { pipeline: "oops" },
    { suppressed: "true" },
    { sourceJob: "bad" },
    { q: "x".repeat(121) },
    { jobQuery: "a\nb" },
    { jobsPage: "0" },
    { companyPage: "1e3" },
    { companyPage: String(Number.MAX_SAFE_INTEGER + 1) },
  ])
    expect(parseDiscoveryIndexQuery(search)).toBeNull();
});
it("handles historical malformed condition/failure payloads without exposing raw JSON or crashing the list", async () => {
  const { actor } = await seedUser(db, "ops");
  await db.insert(discoveryJobs).values({
    provider: "fixture",
    criteria: { keywords: "old format", city: "x".repeat(5000), unknown: "hidden" },
    failures: { unexpected: "hidden" },
  });
  const data = result(await readDiscoveryIndex(db, actor, query()));
  expect(data.jobs.items[0]?.condition.city).toHaveLength(80);
  expect(data.jobs.items[0]?.condition.keywords).toBeNull();
  expect(data.jobs.items[0]?.failureCount).toBe(0);
  expect(JSON.stringify(data)).not.toContain("hidden");
  expect(
    discoveryConditionText({
      prefecture: null,
      city: null,
      cityCode: null,
      industry: null,
      keywords: null,
      limit: null,
    }),
  ).toBe("地域の指定なし");
});
