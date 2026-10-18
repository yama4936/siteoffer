import { randomUUID } from "node:crypto";
import { companies, type Db, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("../session", () => ({ getCurrentActor: vi.fn() }));

import { websiteCandidateAction, websiteReviewAction } from "../../app/(ops)/ops/companies/[companyId]/website-actions";
import { getDb } from "../db";
import { getCurrentActor } from "../session";
import { seedUser } from "./test-seed";
import { websiteReviewFingerprint } from "./website-candidate";

let db: Db, close: () => Promise<void>;
const initial = { nonce: "", ok: false, message: "" };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  vi.mocked(getDb).mockReturnValue(db);
});
afterEach(async () => {
  await close();
  vi.resetAllMocks();
});
async function setup() {
  const { actor } = await seedUser(db, "ops");
  vi.mocked(getCurrentActor).mockResolvedValue(actor);
  const [company] = await db.insert(companies).values({ name: "受付用の架空企業" }).returning();
  const form = new FormData();
  for (const [key, value] of Object.entries({
    companyId: company!.id,
    expected: websiteReviewFingerprint(company!),
    requestId: randomUUID(),
    url: "https://action.example.test/",
    sourceUrl: "https://source.example.test/",
    note: "所在地と社名が一致",
  }))
    form.set(key, value);
  return { actor, company: company!, form };
}
it("connects both server actions to storage with separate candidate and explicit confirmed-site steps", async () => {
  const s = await setup();
  expect((await websiteCandidateAction(initial, s.form)).ok).toBe(false);
  expect(await db.select().from(websites)).toHaveLength(0);
  s.form.set("confirmed", "on");
  expect((await websiteCandidateAction(initial, s.form)).ok).toBe(true);
  expect((await websiteCandidateAction(initial, s.form)).ok).toBe(true);
  expect(await db.select().from(websites)).toHaveLength(1);
  const [company] = await db.select().from(companies).where(eq(companies.id, s.company.id)),
    [site] = await db.select().from(websites);
  expect(company!.officialSiteStatus).toBe("needs_review");
  const form = new FormData();
  form.set("companyId", company!.id);
  form.set("websiteId", site!.id);
  form.set("status", "confirmed");
  form.set("expected", websiteReviewFingerprint(company!, site!));
  expect((await websiteReviewAction(initial, form)).ok).toBe(false);
  form.set("confirmed", "on");
  expect((await websiteReviewAction(initial, form)).ok).toBe(true);
  expect((await db.select().from(companies))[0]!.officialSiteStatus).toBe("confirmed");
  expect((await db.select().from(websites))[0]!.isPrimary).toBe(true);
  expect(revalidatePath).toHaveBeenCalledWith(`/ops/companies/${company!.id}`);
  expect(revalidatePath).toHaveBeenCalledWith("/ops/discovery");
  expect(revalidatePath).toHaveBeenCalledWith("/ops/processing");
});
it("returns safe errors and leaves storage untouched for unavailable authorization and malformed review snapshots", async () => {
  const s = await setup();
  s.form.set("confirmed", "on");
  vi.mocked(getCurrentActor).mockResolvedValue(null);
  expect((await websiteCandidateAction(initial, s.form)).ok).toBe(false);
  const form = new FormData();
  form.set("companyId", s.company.id);
  form.set("status", "confirmed");
  form.set("confirmed", "on");
  form.set("expected", "bad");
  expect((await websiteReviewAction(initial, form)).ok).toBe(false);
  vi.mocked(getDb).mockImplementation(() => {
    throw Error("private connection details");
  });
  const failure = await websiteCandidateAction(initial, s.form);
  expect(failure.ok).toBe(false);
  expect(failure.message).not.toContain("private");
  expect(await db.select().from(websites)).toHaveLength(0);
});
