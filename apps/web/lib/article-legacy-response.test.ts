import { randomUUID } from "node:crypto";
import { changeArticleLegacyPaths, fixedClock, listArticleLegacyPaths } from "@siteoffer/core";
import { contentEntries, contentRevisions, type Db, deliveries } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeliveryForContract } from "../../../packages/core/src/delivery/delivery.ts";
import { seedDeliveryBase } from "../../../packages/core/src/delivery/test-helpers.ts";

vi.mock("./article-legacy-db", () => ({ getArticleLegacyDb: vi.fn() }));

import { proxy } from "../proxy";
import { getArticleLegacyDb } from "./article-legacy-db";
import { articleLegacyResponse } from "./article-legacy-response";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-18T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  vi.mocked(getArticleLegacyDb).mockReturnValue(db);
});
afterEach(async () => {
  await close();
  vi.resetAllMocks();
});
it("handles WordPress root queries and the reserved news page without intercepting canonical article URLs", async () => {
  const s = await seedDeliveryBase(db),
    created = await createDeliveryForContract(db, clock, s.ops, s.contract.id);
  if (!created.ok) throw Error(created.error);
  await db.update(deliveries).set({ status: "published" }).where(eq(deliveries.id, created.value.delivery.id));
  const [entry] = await db
    .insert(contentEntries)
    .values({
      companyId: s.company.id,
      slug: "imported",
      sourceUrl: "https://old.example.test/?p=42",
      publishedRevision: 1,
      updatedAt: clock.now(),
    })
    .returning();
  await db.insert(contentRevisions).values({
    entryId: entry!.id,
    revision: 1,
    title: "掲載済み",
    body: "掲載本文",
    category: "news",
    createdBy: s.ops.userId,
  });
  async function enable() {
    const page = await listArticleLegacyPaths(db, s.ops, s.company.id, { page: 1, query: "", state: "all" });
    await changeArticleLegacyPaths(
      db,
      clock,
      s.ops,
      s.company.id,
      "enable",
      page.items.map(({ id, fingerprint, legacyRevision }) => ({ id, fingerprint, legacyRevision })),
      true,
    );
  }
  await enable();
  const root = await articleLegacyResponse(new Request(`http://local/published/${s.company.id}?p=42`), s.company.id);
  expect(root.status).toBe(308);
  expect(root.headers.get("location")).toBe(`/published/${s.company.id}/news?article=imported`);
  await db
    .update(contentEntries)
    .set({ sourceUrl: "https://old.example.test/news?p=42" })
    .where(eq(contentEntries.id, entry!.id));
  await enable();
  for (const method of ["GET", "HEAD"]) {
    const response = await proxy(new NextRequest(`http://local/published/${s.company.id}/news?p=42`, { method }));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`/published/${s.company.id}/news?article=imported`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  }
  const canonical = await proxy(new NextRequest(`http://local/published/${s.company.id}/news?article=imported`));
  expect(canonical.headers.get("x-middleware-next")).toBe("1");
  expect(
    (await proxy(new NextRequest(`http://local/published/${s.company.id}/news?p=42`, { method: "POST" }))).headers.get(
      "x-middleware-next",
    ),
  ).toBe("1");
});
it("serves permanent same-company GET/HEAD redirects only after actual opt-in and publication, and fails closed on outage", async () => {
  const s = await seedDeliveryBase(db),
    delivery = await createDeliveryForContract(db, clock, s.ops, s.contract.id);
  if (!delivery.ok) throw Error(delivery.error);
  await db.update(deliveries).set({ status: "published" }).where(eq(deliveries.id, delivery.value.delivery.id));
  const [entry] = await db
    .insert(contentEntries)
    .values({
      companyId: s.company.id,
      slug: "destination",
      sourceUrl: "https://old.example.test/legacy.php?id=42",
      publishedRevision: 1,
      updatedAt: clock.now(),
    })
    .returning();
  await db.insert(contentRevisions).values({
    entryId: entry!.id,
    revision: 1,
    title: "掲載記事",
    body: "本文",
    category: "news",
    createdBy: s.ops.userId,
  });
  const url = `http://local/published/${s.company.id}/legacy.php?id=42`;
  expect((await articleLegacyResponse(new Request(url), s.company.id)).status).toBe(404);
  const data = await listArticleLegacyPaths(db, s.ops, s.company.id, { page: 1, query: "", state: "all" });
  await changeArticleLegacyPaths(
    db,
    clock,
    s.ops,
    s.company.id,
    "enable",
    data.items.map(({ id, fingerprint, legacyRevision }) => ({ id, fingerprint, legacyRevision })),
    true,
  );
  for (const method of ["GET", "HEAD"]) {
    const response = await articleLegacyResponse(new Request(url, { method }), s.company.id);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`/published/${s.company.id}/news?article=destination`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  }
  expect((await articleLegacyResponse(new Request(url, { method: "POST" }), s.company.id)).status).toBe(405);
  expect(
    (await articleLegacyResponse(new Request(`http://local/published/${randomUUID()}/legacy.php?id=42`), s.company.id))
      .status,
  ).toBe(404);
  await db.update(contentEntries).set({ publishedRevision: null }).where(eq(contentEntries.id, entry!.id));
  expect((await articleLegacyResponse(new Request(url), s.company.id)).status).toBe(404);
  vi.mocked(getArticleLegacyDb).mockImplementation(() => {
    throw Error("internal database details");
  });
  const failure = await articleLegacyResponse(new Request(url), s.company.id);
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain("internal");
  expect(await (await articleLegacyResponse(new Request(url, { method: "HEAD" }), s.company.id)).text()).toBe("");
});
