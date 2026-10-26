import { randomUUID } from "node:crypto";
import { auditEvents, contentEntries, contentRevisions, type Db, deliveries, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import { changeArticleLegacyPaths, listArticleLegacyPaths, resolveArticleLegacyPath } from "./content-legacy.ts";
import { articleLegacyPath, normalizeArticleLegacyPath } from "./content-legacy-path.ts";
import { createDeliveryForContract } from "./delivery/delivery.ts";
import { seedDeliveryBase } from "./delivery/test-helpers.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-18T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
const filters = { page: 1, query: "", state: "all" as const };
async function setup() {
  const b = await seedDeliveryBase(db);
  const d = await createDeliveryForContract(db, clock, b.ops, b.contract.id);
  if (!d.ok) throw Error(d.error);
  await db.update(deliveries).set({ status: "published" }).where(eq(deliveries.id, d.value.delivery.id));
  const [entry] = await db
    .insert(contentEntries)
    .values({
      companyId: b.company.id,
      slug: "new-article",
      sourceUrl: "https://old.example.test/news/old.html",
      publishedRevision: 1,
      publicationRevision: 1,
      publishedAt: clock.now(),
      updatedAt: clock.now(),
    })
    .returning();
  await db.insert(contentRevisions).values({
    entryId: entry!.id,
    revision: 1,
    title: "掲載済みの記事",
    body: "掲載済み本文",
    category: "news",
    createdBy: b.ops.userId,
  });
  return { ...b, entry: entry!, delivery: d.value.delivery };
}
async function selection(s: Awaited<ReturnType<typeof setup>>, id = s.entry.id) {
  const data = await listArticleLegacyPaths(db, s.ops, s.company.id, filters);
  const row = data.items.find((row) => row.id === id)!;
  return { id: row.id, fingerprint: row.fingerprint, legacyRevision: row.legacyRevision };
}
it("requires explicit opt-in, redirects only to this company's published article, and supports idempotent enable and reversible disable", async () => {
  const s = await setup(),
    old = "/news/old.html";
  expect(await resolveArticleLegacyPath(db, s.company.id, old)).toBeNull();
  const chosen = await selection(s);
  expect(await changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [chosen], true)).toMatchObject({
    changed: 1,
  });
  expect(await resolveArticleLegacyPath(db, s.company.id, old)).toBe(
    `/published/${s.company.id}/news?article=new-article`,
  );
  expect(await resolveArticleLegacyPath(db, s.company.id, `${old}?extra=1`)).toBeNull();
  expect(await changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [chosen], true)).toMatchObject({
    changed: 0,
  });
  expect((await db.select().from(auditEvents)).filter((row) => row.action === "content.legacy.enable")).toHaveLength(1);
  await changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "disable", [await selection(s)], true);
  expect(await resolveArticleLegacyPath(db, s.company.id, old)).toBeNull();
  await expect(changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [chosen], true)).rejects.toThrow(
    "変わりました",
  );
});
it("checks site and article publication at every resolution, using the current slug without publishing drafts", async () => {
  const s = await setup();
  await changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [await selection(s)], true);
  await db.update(contentEntries).set({ publishedRevision: null }).where(eq(contentEntries.id, s.entry.id));
  expect(await resolveArticleLegacyPath(db, s.company.id, "/news/old.html")).toBeNull();
  await db
    .update(contentEntries)
    .set({ publishedRevision: 1, slug: "renamed" })
    .where(eq(contentEntries.id, s.entry.id));
  expect(await resolveArticleLegacyPath(db, s.company.id, "/news/old.html")).toContain("article=renamed");
  await db.update(deliveries).set({ status: "building" }).where(eq(deliveries.id, s.delivery.id));
  expect(await resolveArticleLegacyPath(db, s.company.id, "/news/old.html")).toBeNull();
});
it("rejects duplicate aliases and stale previews atomically, isolates companies, and flags a path already used by another article", async () => {
  const s = await setup();
  const [second] = await db
    .insert(contentEntries)
    .values({ companyId: s.company.id, slug: "second", sourceUrl: s.entry.sourceUrl, updatedAt: clock.now() })
    .returning();
  const all = await listArticleLegacyPaths(db, s.ops, s.company.id, filters);
  await expect(
    changeArticleLegacyPaths(
      db,
      clock,
      s.ops,
      s.company.id,
      "enable",
      all.items.map(({ id, fingerprint, legacyRevision }) => ({ id, fingerprint, legacyRevision })),
      true,
    ),
  ).rejects.toThrow("複数");
  expect((await db.select().from(contentEntries)).every((row) => row.legacyPath === null)).toBe(true);
  const old = await selection(s);
  await db.update(contentEntries).set({ slug: "changed" }).where(eq(contentEntries.id, s.entry.id));
  await expect(changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [old], true)).rejects.toThrow(
    "変わりました",
  );
  await changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [await selection(s)], true);
  expect(
    (await listArticleLegacyPaths(db, s.ops, s.company.id, filters)).items.find((row) => row.id === second!.id)
      ?.conflict,
  ).toBe(true);
  await expect(
    changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [await selection(s, second!.id)], true),
  ).rejects.toThrow("別の記事");
  const other = await setup();
  expect(await resolveArticleLegacyPath(db, other.company.id, "/news/old.html")).toBeNull();
  await changeArticleLegacyPaths(db, clock, other.ops, other.company.id, "enable", [await selection(other)], true);
  expect(await resolveArticleLegacyPath(db, other.company.id, "/news/old.html")).toContain(other.company.id);
});
it("enforces active ops, confirmation, company ownership, and bounded selections", async () => {
  const s = await setup(),
    chosen = await selection(s);
  for (const actor of [null, s.sales, { kind: "ops" as const, userId: s.sales.userId }]) {
    await expect(listArticleLegacyPaths(db, actor, s.company.id, filters)).rejects.toThrow("運営");
    await expect(changeArticleLegacyPaths(db, clock, actor, s.company.id, "enable", [chosen], true)).rejects.toThrow(
      "運営",
    );
  }
  await expect(changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [chosen], false)).rejects.toThrow(
    "確認",
  );
  for (const confirmed of ["true", 1, {}])
    await expect(
      changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [chosen], confirmed as never),
    ).rejects.toThrow("確認");
  for (const rows of [
    [],
    Array(101).fill(chosen),
    [{ ...chosen, id: randomUUID() }],
    [{ ...chosen, legacyRevision: -1 }],
  ])
    await expect(changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", rows, true)).rejects.toThrow();
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  await expect(changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [chosen], true)).rejects.toThrow(
    "運営",
  );
  expect(await resolveArticleLegacyPath(db, s.company.id, "/news/old.html")).toBeNull();
});
it("pages every source URL without article bodies and distinguishes inactive and active aliases", async () => {
  const s = await setup();
  await db.insert(contentEntries).values(
    Array.from({ length: 120 }, (_, index) => ({
      companyId: s.company.id,
      slug: `legacy-${index}`,
      sourceUrl: `https://old.example.test/posts/${index}`,
      updatedAt: clock.now(),
    })),
  );
  const first = await listArticleLegacyPaths(db, s.ops, s.company.id, filters);
  expect(first).toMatchObject({ total: 121, pages: 7 });
  expect(first.items).toHaveLength(20);
  expect(first.items[0]).not.toHaveProperty("body");
  const last = await listArticleLegacyPaths(db, s.ops, s.company.id, { ...filters, page: Number.MAX_SAFE_INTEGER });
  expect(last).toMatchObject({ page: 7, pages: 7 });
  expect(last.items).toHaveLength(1);
  await changeArticleLegacyPaths(
    db,
    clock,
    s.ops,
    s.company.id,
    "enable",
    [
      {
        id: first.items[0]!.id,
        fingerprint: first.items[0]!.fingerprint,
        legacyRevision: first.items[0]!.legacyRevision,
      },
    ],
    true,
  );
  expect((await listArticleLegacyPaths(db, s.ops, s.company.id, { ...filters, state: "active" })).total).toBe(1);
  expect((await listArticleLegacyPaths(db, s.ops, s.company.id, { ...filters, state: "inactive" })).total).toBe(120);
  expect((await listArticleLegacyPaths(db, s.ops, s.company.id, { ...filters, query: "%" })).total).toBe(0);
});
it("canonicalizes safe Japanese and query paths, rejects reserved routes, tokens, traversal and external targets", () => {
  for (const [input, expected] of [
    ["https://old.example.test/お知らせ/春.html", "/%E3%81%8A%E7%9F%A5%E3%82%89%E3%81%9B/%E6%98%A5.html"],
    ["https://old.example.test/?p=123", "/?p=123"],
    ["https://old.example.test/news?z=2&p=1", "/news?p=1&z=2"],
    ["https://old.example.test/old/", "/old"],
  ]) {
    expect(articleLegacyPath(input!)).toBe(expected);
    expect(normalizeArticleLegacyPath(expected!)).toBe(expected);
  }
  for (const value of [
    "/",
    "/news",
    "/news?article=x",
    "/news?page=2",
    "/news/images/x/y",
    "//evil.test/path",
    "/a/../b",
    "/a/%2e%2e/b",
    "/a%2Fb",
    "/a%252fb",
    "/x?token=secret",
    "/x?api_key=secret",
    "/x#frag",
    "/x\\y",
    "/x%00",
    "/x%ZZ",
    "/x?text=%82%A0",
    "/\ud800",
  ])
    expect(normalizeArticleLegacyPath(value)).toBeNull();
  for (const value of [
    "https://user:password@old.example.test/a",
    "https://old.example.test/a#fragment",
    "javascript:alert(1)",
    "https://old.example.test/a/../b",
  ])
    expect(articleLegacyPath(value)).toBeNull();
});
it("accepts an explicit safe path without overwriting source provenance, audits exact changes, and rejects conflicting or unsafe manual paths", async () => {
  const s = await setup();
  await db.update(contentEntries).set({ sourceUrl: null }).where(eq(contentEntries.id, s.entry.id));
  const page = await listArticleLegacyPaths(db, s.ops, s.company.id, filters);
  expect(page.items[0]?.sourceUrl).toBeNull();
  expect(page.items[0]?.path).toBeNull();
  const chosen = { ...(await selection(s)), path: "/以前の記事.html?b=2&a=1" };
  expect(await changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [chosen], true)).toMatchObject({
    changed: 1,
  });
  expect(await resolveArticleLegacyPath(db, s.company.id, chosen.path)).toBe(
    `/published/${s.company.id}/news?article=new-article`,
  );
  expect((await db.select().from(contentEntries).where(eq(contentEntries.id, s.entry.id)))[0]?.sourceUrl).toBeNull();
  const searched = await listArticleLegacyPaths(db, s.ops, s.company.id, { ...filters, query: "a=1&b=2" });
  expect(searched.total).toBe(1);
  expect(searched.items[0]?.id).toBe(s.entry.id);
  expect((await listArticleLegacyPaths(db, s.ops, s.company.id, { ...filters, query: "not-present" })).total).toBe(0);
  const event = (await db.select().from(auditEvents)).find((event) => event.action === "content.legacy.enable");
  expect(event?.after).toMatchObject({
    paths: [{ entryId: s.entry.id, from: null, to: normalizeArticleLegacyPath(chosen.path) }],
  });
  expect(await changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [chosen], true)).toMatchObject({
    changed: 0,
  });
  for (const path of [
    "https://evil.example.test/a",
    "//evil.example.test/a",
    "/news?article=wrong",
    "/x?accessToken=secret",
    "/x?text=%82%A0",
  ])
    await expect(
      changeArticleLegacyPaths(db, clock, s.ops, s.company.id, "enable", [{ ...(await selection(s)), path }], true),
    ).rejects.toThrow("引き継げない");
  const [second] = await db
    .insert(contentEntries)
    .values({ companyId: s.company.id, slug: "manual-second", updatedAt: clock.now() })
    .returning();
  await expect(
    changeArticleLegacyPaths(
      db,
      clock,
      s.ops,
      s.company.id,
      "enable",
      [{ ...(await selection(s, second!.id)), path: chosen.path }],
      true,
    ),
  ).rejects.toThrow("別の記事");
});
