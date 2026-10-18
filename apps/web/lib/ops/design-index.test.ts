import { randomUUID } from "node:crypto";
import { DEFAULT_DESIGN_BRIEF } from "@siteoffer/core";
import { companies, type Db, designVersions, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readDesignIndex } from "./design-index";
import { designIndexHref, designIndexParams, keepsDesignScope, parseDesignIndexQuery } from "./design-index-query";
import { seedCandidate, seedUser } from "./test-seed";

let db: Db, close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
const query = (search: Record<string, string> = {}) => parseDesignIndexQuery(search)!;
function result<T>(value: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!value.ok) throw new Error(value.error);
  return value.value;
}

it("finds older than 300 companies with literal name and location searches, pages all results, and keeps the editor selection", async () => {
  const { actor } = await seedUser(db, "ops"),
    target = await seedCandidate(db);
  await db
    .update(companies)
    .set({ name: "探す_100%工務店", updatedAt: new Date("2020-01-01T00:00:00Z") })
    .where(eq(companies.id, target.company.id));
  await db.insert(companies).values(
    Array.from({ length: 350 }, (_, index) => ({
      name: `検索候補${String(index).padStart(3, "0")}`,
      updatedAt: new Date("2026-10-18T00:00:00Z"),
    })),
  );
  const legacy = await db.select({ id: companies.id }).from(companies).orderBy(desc(companies.updatedAt)).limit(300);
  expect(legacy.some((item) => item.id === target.company.id)).toBe(false);
  const first = result(
    await readDesignIndex(db, actor, query({ company: target.company.id, design: "new", audit: "none" })),
  );
  expect(first.companies).toMatchObject({ total: 351, page: 1, pages: 18 });
  expect(first.companies.items).toHaveLength(20);
  expect(first.company?.id).toBe(target.company.id);
  for (const term of ["探す_100%", "愛知県", "名古屋市", "_"]) {
    const found = result(await readDesignIndex(db, actor, query({ company: target.company.id, companyQuery: term })));
    expect(found.companies.items.map((item) => item.id)).toEqual([target.company.id]);
  }
  const last = result(await readDesignIndex(db, actor, query({ companyPage: String(Number.MAX_SAFE_INTEGER) })));
  expect(last.companies).toMatchObject({ page: 18, pages: 18 });
  expect(last.companies.items).toHaveLength(11);
  const empty = result(
    await readDesignIndex(
      db,
      actor,
      query({ company: target.company.id, design: "new", audit: "none", companyQuery: "該当なし" }),
    ),
  );
  expect(empty.company?.id).toBe(target.company.id);
  expect(empty.companies.total).toBe(0);
});

it("bounds 501 design histories without loading their briefs or images and selects an older version independently", async () => {
  const { actor } = await seedUser(db, "ops"),
    target = await seedCandidate(db);
  const rows = Array.from({ length: 501 }, (_, index) => ({
    id: randomUUID(),
    companyId: target.company.id,
    auditId: target.audit.id,
    version: index + 1,
    requestKey: randomUUID(),
    status: index % 2 ? ("rejected" as const) : ("in_review" as const),
    brief: { ...DEFAULT_DESIGN_BRIEF, direction: "検証".repeat(500) },
    companySnapshot: { detail: "x".repeat(6000) },
    prompt: "x".repeat(4096),
    source: "import",
    imageBase64: "eA==".repeat(2000),
  }));
  for (let start = 0; start < rows.length; start += 50)
    await db.insert(designVersions).values(rows.slice(start, start + 50));
  const selectedId = rows[0]!.id;
  const page = result(
    await readDesignIndex(
      db,
      actor,
      query({ company: target.company.id, design: selectedId, audit: "none", historyPage: "2" }),
    ),
  );
  expect(page.history).toMatchObject({ total: 501, page: 2, pages: 26 });
  expect(page.history.items).toHaveLength(20);
  expect(page.selected?.id).toBe(selectedId);
  expect(page.selected?.version).toBe(1);
  expect(page.history.items.some((item) => item.id === selectedId)).toBe(false);
  expect(Object.keys(page.history.items[0]!).sort()).toEqual(["id", "status", "version"]);
  expect(page.selected).not.toHaveProperty("imageBase64");
  expect(page.selected).not.toHaveProperty("prompt");
  expect(page.selected).not.toHaveProperty("companySnapshot");
  expect(Buffer.byteLength(JSON.stringify(page.history))).toBeLessThan(3000);
  const last = result(await readDesignIndex(db, actor, query({ company: target.company.id, historyPage: "99999" })));
  expect(last.history).toMatchObject({ page: 26, pages: 26 });
  expect(last.history.items).toHaveLength(1);
  expect(last.selected?.version).toBe(501);
  const filtered = result(
    await readDesignIndex(
      db,
      actor,
      query({ company: target.company.id, design: selectedId, historyState: "rejected" }),
    ),
  );
  expect(filtered.history.total).toBe(250);
  expect(filtered.history.items.every((item) => item.status === "rejected")).toBe(true);
  expect(filtered.selected?.id).toBe(selectedId);
  const none = result(await readDesignIndex(db, actor, query({ company: target.company.id, historyState: "failed" })));
  expect(none.history.total).toBe(0);
  expect(none.selected?.version).toBe(501);
});

it("requires active ops, refuses cross-company versions, and returns an empty initial state without inventing a company", async () => {
  const { actor, user } = await seedUser(db, "ops"),
    sales = await seedUser(db, "sales");
  for (const denied of [null, sales.actor, { kind: "ops" as const, userId: sales.user.id }])
    expect(await readDesignIndex(db, denied, query())).toMatchObject({ ok: false, error: "forbidden" });
  const empty = result(await readDesignIndex(db, actor, query()));
  expect(empty.company).toBeNull();
  expect(empty.companies.total).toBe(0);
  const a = await seedCandidate(db),
    b = await seedCandidate(db),
    id = randomUUID();
  await db.insert(designVersions).values({
    id,
    companyId: b.company.id,
    auditId: b.audit.id,
    version: 1,
    requestKey: randomUUID(),
    status: "draft",
    brief: DEFAULT_DESIGN_BRIEF,
    companySnapshot: {},
    prompt: "",
    source: "import",
  });
  expect(await readDesignIndex(db, actor, query({ company: a.company.id, design: id }))).toMatchObject({
    ok: false,
    error: "not_found",
  });
  expect(await readDesignIndex(db, actor, query({ company: randomUUID() }))).toMatchObject({
    ok: false,
    error: "not_found",
  });
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
  expect(await readDesignIndex(db, actor, query())).toMatchObject({ ok: false, error: "forbidden" });
});

it("validates filters and preserves only the exact pinned company, version, and audit across safe navigation", () => {
  const company = randomUUID(),
    design = randomUUID(),
    audit = randomUUID();
  for (const invalid of [
    { company: [company, company] },
    { company, design: [design] },
    { company, audit: "bad" },
    { companyPage: "0" },
    { historyPage: "1.5" },
    { historyPage: "9007199254740992" },
    { historyState: "deleted" },
    { companyQuery: "a\u0000b" },
    { companyQuery: "x".repeat(121) },
    { design },
  ])
    expect(parseDesignIndexQuery(invalid)).toBeNull();
  const original = query({
    company,
    design,
    audit,
    companyQuery: "名古屋",
    companyPage: "8",
    historyState: "approved",
    historyPage: "3",
  });
  const roundTrip = parseDesignIndexQuery(
    Object.fromEntries(new URL(designIndexHref(original), "http://local").searchParams),
  );
  expect(roundTrip).toEqual(original);
  const scope = { companyId: company, designId: design, auditId: audit };
  expect(keepsDesignScope({ ...original, companyPage: 9, historyState: "all", historyPage: 1 }, scope)).toBe(true);
  for (const changed of [
    { companyId: randomUUID() },
    { designId: "new" },
    { auditId: "none" },
    { designId: null },
    { auditId: null },
  ])
    expect(keepsDesignScope({ ...original, ...changed }, scope)).toBe(false);
  expect([...designIndexParams(query({ company, design: "new", audit: "none" })).keys()]).toEqual([
    "company",
    "design",
    "audit",
  ]);
});
