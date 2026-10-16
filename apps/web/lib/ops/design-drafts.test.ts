import { randomUUID } from "node:crypto";
import { DEFAULT_DESIGN_BRIEF, fixedClock } from "@siteoffer/core";
import { type Db, designBriefDrafts, designVersions, siteAudits, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DesignDraftScope } from "./design-draft-types";
import { createDesignFromDraft, DesignDraftConflict, loadDesignDraft, saveDesignDraft } from "./design-drafts";
import { seedCandidate, seedUser } from "./test-seed";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-16T12:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
async function setup() {
  const { actor, user } = await seedUser(db, "ops");
  const { company, audit } = await seedCandidate(db);
  await db.update(siteAudits).set({ decision: "create" }).where(eq(siteAudits.id, audit.id));
  const scope: DesignDraftScope = { companyId: company.id, designId: null, auditId: audit.id };
  return { actor, user, scope };
}
it("restores partial input exactly, separated by account, company and source version", async () => {
  const { actor, scope } = await setup();
  const partial = { ...DEFAULT_DESIGN_BRIEF, audience: "", objective: "  入力途中\n続き  " };
  await saveDesignDraft(db, clock, actor, scope, 0, partial);
  expect(await loadDesignDraft(db, actor, scope)).toMatchObject({ revision: 1, values: partial });
  const other = await seedUser(db, "ops");
  expect((await loadDesignDraft(db, other.actor, scope)).values).toBeNull();
  const second = await setup();
  expect((await loadDesignDraft(db, actor, second.scope)).values).toBeNull();
  const id = await createDesignFromDraft(db, clock, actor, scope, {
    revision: 1,
    brief: DEFAULT_DESIGN_BRIEF,
    source: "import",
    requestKey: randomUUID(),
  });
  expect((await loadDesignDraft(db, actor, { ...scope, designId: id })).revision).toBe(0);
});
it("rejects unauthenticated, sales, inactive operators and cross-company references", async () => {
  const { actor, user, scope } = await setup();
  const sales = await seedUser(db, "sales");
  for (const denied of [null, sales.actor]) {
    await expect(loadDesignDraft(db, denied, scope)).rejects.toThrow("運営");
    await expect(saveDesignDraft(db, clock, denied, scope, 0, DEFAULT_DESIGN_BRIEF)).rejects.toThrow("運営");
  }
  const second = await setup();
  await expect(
    saveDesignDraft(db, clock, actor, { ...scope, auditId: second.scope.auditId }, 0, DEFAULT_DESIGN_BRIEF),
  ).rejects.toThrow("診断");
  await expect(loadDesignDraft(db, actor, { ...scope, designId: randomUUID() })).rejects.toThrow("デザイン");
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
  await expect(loadDesignDraft(db, actor, scope)).rejects.toThrow("運営");
});
it("a stale tab cannot overwrite or erase another tab's update", async () => {
  const { actor, scope } = await setup();
  const newer = { ...DEFAULT_DESIGN_BRIEF, objective: "別タブの入力" };
  await saveDesignDraft(db, clock, actor, scope, 0, newer);
  await expect(saveDesignDraft(db, clock, actor, scope, 0, DEFAULT_DESIGN_BRIEF)).rejects.toMatchObject({
    snapshot: { revision: 1, values: newer },
  });
  await expect(saveDesignDraft(db, clock, actor, scope, 0, null)).rejects.toBeInstanceOf(DesignDraftConflict);
  expect((await loadDesignDraft(db, actor, scope)).values).toEqual(newer);
});
it("discard retains a tombstone so an in-flight save cannot resurrect the draft", async () => {
  const { actor, scope } = await setup();
  await saveDesignDraft(db, clock, actor, scope, 0, DEFAULT_DESIGN_BRIEF);
  expect(await saveDesignDraft(db, clock, actor, scope, 1, null)).toMatchObject({ revision: 2, values: null });
  await expect(saveDesignDraft(db, clock, actor, scope, 1, DEFAULT_DESIGN_BRIEF)).rejects.toBeInstanceOf(
    DesignDraftConflict,
  );
  expect((await loadDesignDraft(db, actor, scope)).values).toBeNull();
});
it("rejects unbounded or unexpected payloads and invalid revisions without modifying data", async () => {
  const { actor, scope } = await setup();
  for (const input of [
    {},
    [],
    "x",
    { ...DEFAULT_DESIGN_BRIEF, password: "x" },
    { ...DEFAULT_DESIGN_BRIEF, scope: "x".repeat(1601) },
  ])
    await expect(saveDesignDraft(db, clock, actor, scope, 0, input)).rejects.toThrow();
  for (const revision of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    await expect(saveDesignDraft(db, clock, actor, scope, revision, DEFAULT_DESIGN_BRIEF)).rejects.toThrow();
  expect(await db.select().from(designBriefDrafts)).toHaveLength(0);
});
it("failed creation preserves the draft and does not leave an incomplete design version", async () => {
  const { actor, scope } = await setup();
  const invalid = { ...DEFAULT_DESIGN_BRIEF, objective: "" };
  await saveDesignDraft(db, clock, actor, scope, 0, invalid);
  await expect(
    createDesignFromDraft(db, clock, actor, scope, {
      revision: 1,
      brief: invalid,
      source: "import",
      requestKey: randomUUID(),
    }),
  ).rejects.toThrow();
  expect((await loadDesignDraft(db, actor, scope)).values).toEqual(invalid);
  expect(await db.select().from(designVersions)).toHaveLength(0);
});
it("creation consumes its draft atomically; retries return the same version and preserve later drafts", async () => {
  const { actor, scope } = await setup();
  await saveDesignDraft(db, clock, actor, scope, 0, DEFAULT_DESIGN_BRIEF);
  const input = { revision: 1, brief: DEFAULT_DESIGN_BRIEF, source: "import" as const, requestKey: randomUUID() };
  const id = await createDesignFromDraft(db, clock, actor, scope, input);
  expect(await loadDesignDraft(db, actor, scope)).toMatchObject({ revision: 2, values: null });
  const later = { ...DEFAULT_DESIGN_BRIEF, objective: "次の案" };
  await saveDesignDraft(db, clock, actor, scope, 2, later);
  expect(await createDesignFromDraft(db, clock, actor, scope, input)).toBe(id);
  expect((await loadDesignDraft(db, actor, scope)).values).toEqual(later);
  expect(await db.select().from(designVersions)).toHaveLength(1);
  await expect(createDesignFromDraft(db, clock, actor, scope, { ...input, brief: later })).rejects.toBeInstanceOf(
    DesignDraftConflict,
  );
});
it("conflicted creation cannot launch an image job or consume the newer draft", async () => {
  const { actor, scope } = await setup();
  await saveDesignDraft(db, clock, actor, scope, 0, DEFAULT_DESIGN_BRIEF);
  await expect(
    createDesignFromDraft(db, clock, actor, scope, {
      revision: 0,
      brief: DEFAULT_DESIGN_BRIEF,
      source: "openai",
      model: "test-only",
      requestKey: randomUUID(),
    }),
  ).rejects.toBeInstanceOf(DesignDraftConflict);
  expect(await db.select().from(designVersions)).toHaveLength(0);
  expect((await loadDesignDraft(db, actor, scope)).values).toEqual(DEFAULT_DESIGN_BRIEF);
});
