import { randomUUID } from "node:crypto";
import { fixedClock } from "@siteoffer/core";
import { auditRequests, companies, type Db, discoveryJobs, users, websites as websiteRows } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { seedCandidate, seedUser } from "./test-seed";
import { emptyWorkFilters, parseWorkFilters, type WorkFilters, workHref } from "./work-filters";
import { getOpsWorkPage, type WorkPage } from "./work-page";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
const must = (r: Awaited<ReturnType<typeof getOpsWorkPage>>) => {
  if (!r.ok) throw Error(r.error);
  return r.value;
};
async function failures(n: number) {
  return db
    .insert(discoveryJobs)
    .values(
      Array.from({ length: n }, (_, i) => ({
        provider: "fixture",
        criteria: { prefecture: "愛知県", city: `架空市${i}` },
        status: "failed" as const,
        createdAt: new Date(2026, 0, 1 + i),
      })),
    )
    .returning();
}
async function websites(n: number) {
  return db
    .insert(companies)
    .values(
      Array.from({ length: n }, (_, i) => ({
        name: `架空の会社${i}`,
        pipelineStatus: "collected" as const,
        officialSiteStatus: "needs_review" as const,
        createdAt: new Date(2025, 0, 1 + i),
      })),
    )
    .returning();
}
it("merges every source in priority order and reaches all rows with bounded pages", async () => {
  const { actor } = await seedUser(db, "ops");
  const stopped = await failures(24),
    sites = await websites(26);
  let filters = emptyWorkFilters;
  const all: WorkPage["items"] = [];
  do {
    const page = must(await getOpsWorkPage(db, actor, filters, clock));
    expect(page.total).toBe(50);
    expect(page.items.length).toBeLessThanOrEqual(20);
    expect(page.skipped).toBe(all.length);
    all.push(...page.items);
    if (!page.nextCursor) break;
    filters = { ...filters, cursor: page.nextCursor };
  } while (all.length <= 60);
  expect(all.map((i) => i.id)).toEqual([...stopped, ...sites].map((i) => i.id));
  expect(new Set(all.map((i) => i.id)).size).toBe(50);
});
it("searches beyond every source's first 20 and treats SQL punctuation literally", async () => {
  const { actor } = await seedUser(db, "ops");
  const sites = await websites(25);
  const target = sites[24]!;
  await db.update(companies).set({ name: "末尾%_\\確認会社" }).where(eq(companies.id, target.id));
  const filters = { ...emptyWorkFilters, query: "%_\\" };
  const page = must(await getOpsWorkPage(db, actor, filters, clock));
  expect(page.items.map((i) => i.id)).toEqual([target.id]);
  expect(page.total).toBe(1);
  expect(page.nextCursor).toBeNull();
  expect(page.groups.find((g) => g.key === "website")?.count).toBe(1);
  expect(must(await getOpsWorkPage(db, actor, { ...filters, query: "不存在" }, clock)).items).toEqual([]);
});
it("filters the group while preserving counts for the other matching groups", async () => {
  const { actor } = await seedUser(db, "ops");
  await failures(23);
  await websites(22);
  const filters: WorkFilters = { ...emptyWorkFilters, group: "discovery" };
  const first = must(await getOpsWorkPage(db, actor, filters, clock));
  expect(first.matchedTotal).toBe(23);
  expect(first.total).toBe(45);
  expect(first.items.every((i) => i.group === "discovery")).toBe(true);
  const second = must(await getOpsWorkPage(db, actor, { ...filters, cursor: first.nextCursor }, clock));
  expect(second.items).toHaveLength(3);
  expect(second.skipped).toBe(20);
  expect(second.nextCursor).toBeNull();
  expect(must(await getOpsWorkPage(db, actor, { ...filters, query: "架空市22" }, clock)).items).toHaveLength(1);
});
it("maintains one stable ID order even when DB timestamps differ within a millisecond", async () => {
  const { actor } = await seedUser(db, "ops"),
    rows = await websites(25);
  for (const [index, row] of rows.entries())
    await db.execute(
      sql`update companies set created_at=${`2026-10-17T00:00:00.000${String(index * 7).padStart(3, "0")}Z`}::timestamptz where id=${row.id}::uuid`,
    );
  const first = must(await getOpsWorkPage(db, actor, emptyWorkFilters, clock));
  const second = must(await getOpsWorkPage(db, actor, { ...emptyWorkFilters, cursor: first.nextCursor }, clock));
  expect([...first.items, ...second.items].map((i) => i.id)).toEqual(rows.map((i) => i.id).sort());
});
it("rejects non-operators, suspended operators and a cursor tied to another filter", async () => {
  expect(await getOpsWorkPage(db, null)).toMatchObject({ ok: false, error: "forbidden" });
  const { actor } = await seedUser(db, "sales");
  expect(await getOpsWorkPage(db, actor)).toMatchObject({ ok: false, error: "forbidden" });
  const { actor: ops, user } = await seedUser(db, "ops");
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
  expect(await getOpsWorkPage(db, ops)).toMatchObject({ ok: false, error: "forbidden" });
  expect(
    await getOpsWorkPage(db, ops, { ...emptyWorkFilters, cursor: { filter: "other", offsets: {} } }),
  ).toMatchObject({ ok: false, error: "invalid_input" });
});
it("handles a bookmarked tail after tasks are resolved without scanning an arbitrary offset", async () => {
  const { actor } = await seedUser(db, "ops");
  await failures(1);
  const filters: WorkFilters = { ...emptyWorkFilters, cursor: { filter: "all\n", offsets: { discovery: 2147483647 } } };
  const page = must(await getOpsWorkPage(db, actor, filters, clock));
  expect(page.total).toBe(1);
  expect(page.items).toEqual([]);
  expect(page.nextCursor).toBeNull();
});
it("validates and round-trips private metadata-only URLs", () => {
  const valid: WorkFilters = {
    group: "website",
    query: "架空%_\\",
    cursor: { filter: "website\n架空%_\\", offsets: { website: 20 } },
  };
  expect(parseWorkFilters(new URL(workHref(valid), "http://local").searchParams)).toEqual(valid);
  for (const value of [
    "group=nope",
    "group=__proto__",
    "q=x&q=y",
    "group=design&group=design",
    "cursor=[]",
    "cursor=not-json",
    `q=${"あ".repeat(201)}`,
    `cursor=${encodeURIComponent(JSON.stringify({ filter: "all\n", offsets: { website: -1 } }))}`,
    `cursor=${encodeURIComponent(JSON.stringify({ filter: "all\n", offsets: { publication_materials: 20 } }))}`,
  ])
    expect(parseWorkFilters(new URLSearchParams(value))).toBeNull();
});

it("pages and searches the delegated preparation and audit-attention sources", async () => {
  const { actor } = await seedUser(db, "ops");
  const made = await db
    .insert(companies)
    .values(
      Array.from({ length: 25 }, (_, i) => ({
        name: `準備対象${i}`,
        pipelineStatus: "collected" as const,
        officialSiteStatus: "confirmed" as const,
      })),
    )
    .returning();
  const sites = await db
    .insert(websiteRows)
    .values(
      made.map((c) => ({
        companyId: c.id,
        url: `https://${c.id}.example/`,
        normalizedUrl: `https://${c.id}.example/`,
        domain: `${c.id}.example`,
        kind: "current" as const,
        isPrimary: true,
      })),
    )
    .returning();
  const filters: WorkFilters = { ...emptyWorkFilters, group: "audit_preparation" };
  const first = must(await getOpsWorkPage(db, actor, filters, clock));
  expect(first.matchedTotal).toBe(25);
  expect(first.items).toHaveLength(20);
  const tail = must(await getOpsWorkPage(db, actor, { ...filters, cursor: first.nextCursor }, clock));
  expect(tail.items).toHaveLength(5);
  expect(new Set([...first.items, ...tail.items].map((r) => r.id)).size).toBe(25);
  expect(
    must(await getOpsWorkPage(db, actor, { ...filters, query: "準備対象24" }, clock)).items.map((r) => r.id),
  ).toEqual([made[24]!.id]);
  const requests = await db
    .insert(auditRequests)
    .values(
      sites.map((site) => ({
        id: randomUUID(),
        companyId: site.companyId,
        websiteId: site.id,
        targetUrl: site.url,
        status: "failed" as const,
        finishedAt: clock.now(),
      })),
    )
    .returning();
  const stopped: WorkFilters = { ...emptyWorkFilters, group: "audit_attention" };
  const failed = must(await getOpsWorkPage(db, actor, stopped, clock));
  const more = must(await getOpsWorkPage(db, actor, { ...stopped, cursor: failed.nextCursor }, clock));
  expect(failed.matchedTotal).toBe(25);
  expect(new Set([...failed.items, ...more.items].map((r) => r.id))).toEqual(new Set(requests.map((r) => r.id)));
  expect(
    must(await getOpsWorkPage(db, actor, { ...stopped, query: "準備対象24" }, clock)).items.map((r) => r.id),
  ).toEqual([requests.find((r) => r.companyId === made[24]!.id)!.id]);
});
it("pages and searches every approved proposal waiting for sales handoff", async () => {
  const { actor } = await seedUser(db, "ops"),
    ids: string[] = [];
  for (let i = 0; i < 25; i++) {
    const c = await seedCandidate(db, { versionStatus: "approved" });
    ids.push(c.company.id);
    await db
      .update(companies)
      .set({ name: `引継ぎ確認${i}` })
      .where(eq(companies.id, c.company.id));
  }
  const filters: WorkFilters = { ...emptyWorkFilters, group: "sales_ready" };
  const first = must(await getOpsWorkPage(db, actor, filters, clock)),
    tail = must(await getOpsWorkPage(db, actor, { ...filters, cursor: first.nextCursor }, clock));
  expect(first.matchedTotal).toBe(25);
  expect(tail.items).toHaveLength(5);
  expect(new Set([...first.items, ...tail.items].map((i) => i.id))).toEqual(new Set(ids));
  expect(
    must(await getOpsWorkPage(db, actor, { ...filters, query: "引継ぎ確認24" }, clock)).items.map((r) => r.id),
  ).toEqual([ids[24]]);
});

it("searches actual confirmation text past 500 rows and paginates the exact matches", async () => {
  const { actor } = await seedUser(db, "ops");
  const all = await websites(501);
  const query = "公式サイトの候補が見つかりました",
    filters: WorkFilters = { ...emptyWorkFilters, group: "website", query };
  const first = must(await getOpsWorkPage(db, actor, filters, clock));
  expect(first.matchedTotal).toBe(501);
  expect(first.items).toHaveLength(20);
  const last = must(
    await getOpsWorkPage(
      db,
      actor,
      { ...filters, cursor: { filter: `website\n${query}`, offsets: { website: 500 } } },
      clock,
    ),
  );
  expect(last.items.map((i) => i.id)).toEqual([all[500]!.id]);
  expect(last.nextCursor).toBeNull();
  const stopped = await failures(24);
  const recovery = must(await getOpsWorkPage(db, actor, { ...emptyWorkFilters, query: "収集が停止しています" }, clock));
  expect(recovery.matchedTotal).toBe(24);
  expect(recovery.items.map((i) => i.id)).toEqual(stopped.slice(0, 20).map((i) => i.id));
});
