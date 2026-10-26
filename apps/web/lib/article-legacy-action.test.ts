import { randomUUID } from "node:crypto";
import { fixedClock, listArticleLegacyPaths, resolveArticleLegacyPath } from "@siteoffer/core";
import { auditEvents, contentEntries, contentRevisions, type Db, deliveries } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeliveryForContract } from "../../../packages/core/src/delivery/delivery.ts";
import { seedDeliveryBase } from "../../../packages/core/src/delivery/test-helpers.ts";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./session", () => ({ getCurrentActor: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { changeLegacyAction } from "../app/(ops)/ops/content/[companyId]/migration/actions";
import { getDb } from "./db";
import { getCurrentActor } from "./session";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-18T00:00:00Z"),
  initial = { nonce: "", ok: false, message: "" };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  vi.mocked(getDb).mockReturnValue(db);
});
afterEach(async () => {
  await close();
  vi.resetAllMocks();
});
async function setup() {
  const s = await seedDeliveryBase(db),
    built = await createDeliveryForContract(db, clock, s.ops, s.contract.id);
  if (!built.ok) throw Error(built.error);
  await db.update(deliveries).set({ status: "published" }).where(eq(deliveries.id, built.value.delivery.id));
  const [entry] = await db
    .insert(contentEntries)
    .values({ companyId: s.company.id, slug: `action-${randomUUID()}`, publishedRevision: 1, updatedAt: clock.now() })
    .returning();
  await db.insert(contentRevisions).values({
    entryId: entry!.id,
    revision: 1,
    title: "掲載済み",
    body: "公開本文",
    category: "news",
    createdBy: s.ops.userId,
  });
  const data = await listArticleLegacyPaths(db, s.ops, s.company.id, { page: 1, query: "", state: "all" });
  const row = data.items[0]!;
  const form = new FormData();
  form.set("companyId", s.company.id);
  form.set("operation", "enable");
  form.set(
    "selected",
    JSON.stringify([
      { id: row.id, fingerprint: row.fingerprint, legacyRevision: row.legacyRevision, path: "/manual-post.html" },
    ]),
  );
  form.set("confirmed", "on");
  vi.mocked(getCurrentActor).mockResolvedValue(s.ops);
  return { ...s, entry: entry!, form };
}
it("connects a confirmed manual-path action to actual storage and public resolution without duplicate audit entries", async () => {
  const s = await setup();
  expect((await changeLegacyAction(initial, s.form)).ok).toBe(true);
  expect(await resolveArticleLegacyPath(db, s.company.id, "/manual-post.html")).toBe(
    `/published/${s.company.id}/news?article=${s.entry.slug}`,
  );
  expect(revalidatePath).toHaveBeenCalledWith(`/ops/content/${s.company.id}/migration`);
  expect(revalidatePath).toHaveBeenCalledWith(`/published/${s.company.id}/news`);
  expect((await changeLegacyAction(initial, s.form)).ok).toBe(true);
  expect((await db.select().from(auditEvents)).filter((row) => row.action === "content.legacy.enable")).toHaveLength(1);
});
it("refuses missing confirmation, malformed data, a different role and stale article state before changing aliases", async () => {
  const s = await setup();
  s.form.delete("confirmed");
  expect((await changeLegacyAction(initial, s.form)).ok).toBe(false);
  s.form.set("confirmed", "on");
  vi.mocked(getCurrentActor).mockResolvedValue(s.sales);
  expect((await changeLegacyAction(initial, s.form)).ok).toBe(false);
  vi.mocked(getCurrentActor).mockResolvedValue(s.ops);
  await db.update(contentEntries).set({ currentRevision: 2 }).where(eq(contentEntries.id, s.entry.id));
  expect((await changeLegacyAction(initial, s.form)).ok).toBe(false);
  s.form.set("selected", "{");
  expect((await changeLegacyAction(initial, s.form)).ok).toBe(false);
  expect((await db.select().from(contentEntries).where(eq(contentEntries.id, s.entry.id)))[0]?.legacyPath).toBeNull();
  expect((await db.select().from(auditEvents)).filter((row) => row.action.startsWith("content.legacy."))).toHaveLength(
    0,
  );
});
