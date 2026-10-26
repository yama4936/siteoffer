import { randomUUID } from "node:crypto";
import { fixedClock } from "@siteoffer/core";
import {
  activityDrafts,
  activitySubmissions,
  assignments,
  auditEvents,
  companies,
  type Db,
  salesActivities,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { seedUser } from "../ops/test-seed";
import { type ActivityValues, emptyActivity, suggestedFollowUp } from "./activity-draft-types";
import { ActivityDraftConflict, commitActivityDraft, loadActivityDraft, saveActivityDraft } from "./activity-drafts";
import { parseJstDateTime } from "./operations";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-16T12:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
async function setup() {
  const { actor, user } = await seedUser(db, "sales");
  const [company] = await db
    .insert(companies)
    .values({ name: "架空・活動下書き検証", pipelineStatus: "sellable" })
    .returning();
  const [a] = await db
    .insert(assignments)
    .values({
      companyId: company!.id,
      userId: user.id,
      status: "working",
      claimedAt: clock.now(),
      expiresAt: new Date("2026-12-01"),
      nextActionAt: new Date("2026-10-18T01:00:00Z"),
    })
    .returning();
  return { actor, user, a: a!, company: company! };
}
const input = (values: ActivityValues, revision = 1) => ({
  values,
  revision,
  requestKey: randomUUID(),
  confirmEnd: false,
});
it("preserves partial values and isolates owners and assignments", async () => {
  const { actor, a } = await setup();
  const values = { ...emptyActivity(clock.now()), occurredAt: "", note: "  通話中\n続き  " };
  await saveActivityDraft(db, clock, actor, a.id, 0, values);
  expect((await loadActivityDraft(db, actor, a.id)).values).toEqual(values);
  const other = await setup();
  await expect(loadActivityDraft(db, other.actor, a.id)).rejects.toThrow("自分");
  await expect(saveActivityDraft(db, clock, other.actor, a.id, 0, values)).rejects.toThrow("自分");
  expect((await loadActivityDraft(db, other.actor, other.a.id)).values).toBeNull();
  const ops = await seedUser(db, "ops");
  for (const denied of [null, ops.actor]) await expect(loadActivityDraft(db, denied, a.id)).rejects.toThrow("営業");
});
it("rejects suspended users and writes to ended assignments", async () => {
  const { actor, user, a } = await setup();
  await db.update(assignments).set({ status: "released" }).where(eq(assignments.id, a.id));
  await expect(saveActivityDraft(db, clock, actor, a.id, 0, emptyActivity(clock.now()))).rejects.toThrow("終了");
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
  await expect(loadActivityDraft(db, actor, a.id)).rejects.toThrow("ログイン");
});
it("stale saves cannot overwrite or resurrect a discarded draft", async () => {
  const { actor, a } = await setup();
  const values = emptyActivity(clock.now());
  await saveActivityDraft(db, clock, actor, a.id, 0, values);
  await expect(saveActivityDraft(db, clock, actor, a.id, 0, { ...values, note: "別タブ" })).rejects.toBeInstanceOf(
    ActivityDraftConflict,
  );
  await saveActivityDraft(db, clock, actor, a.id, 1, null);
  await expect(saveActivityDraft(db, clock, actor, a.id, 1, values)).rejects.toBeInstanceOf(ActivityDraftConflict);
  expect(await loadActivityDraft(db, actor, a.id)).toMatchObject({ revision: 2, values: null });
});
it("drafts reject secrets, extra fields and oversized input without erasing the saved copy", async () => {
  const { actor, a } = await setup();
  const values = emptyActivity(clock.now());
  await saveActivityDraft(db, clock, actor, a.id, 0, values);
  for (const bad of [
    { ...values, note: "password: test-secret-only" },
    { ...values, note: "x".repeat(2001) },
    { ...values, confirmEnd: true },
    { ...values, consultOps: "yes" },
    { ...values, occurredAt: "invalid-date" },
  ])
    await expect(saveActivityDraft(db, clock, actor, a.id, 1, bad)).rejects.toThrow();
  expect((await loadActivityDraft(db, actor, a.id)).values).toEqual(values);
});
it("records exactly once after a lost response and preserves a later working copy", async () => {
  const { actor, a } = await setup();
  const values = { ...emptyActivity(clock.now()), note: "相談したい", consultOps: true };
  await saveActivityDraft(db, clock, actor, a.id, 0, values);
  const request = input(values);
  const first = await commitActivityDraft(db, clock, actor, a.id, request);
  expect(first.snapshot).toMatchObject({ revision: 2, values: null });
  await saveActivityDraft(db, clock, actor, a.id, 2, { ...values, note: "次の活動" });
  const retry = await commitActivityDraft(db, clock, actor, a.id, request);
  expect(retry.activityId).toBe(first.activityId);
  expect(retry.snapshot.values?.note).toBe("次の活動");
  expect(await db.select().from(salesActivities)).toHaveLength(1);
  expect(await db.select().from(activitySubmissions)).toHaveLength(1);
});
it("invalid dates and required callback dates preserve the draft and business state", async () => {
  const { actor, a } = await setup();
  const values = {
    ...emptyActivity(clock.now()),
    kind: "callback_scheduled" as const,
    nextActionMode: "replace" as const,
    nextActionAt: "2026-10-15T10:00",
  };
  await saveActivityDraft(db, clock, actor, a.id, 0, values);
  await expect(commitActivityDraft(db, clock, actor, a.id, input(values))).rejects.toThrow("現在より後");
  expect((await loadActivityDraft(db, actor, a.id)).values).toEqual(values);
  expect(await db.select().from(salesActivities)).toHaveLength(0);
  const [after] = await db.select().from(assignments).where(eq(assignments.id, a.id));
  expect(after?.nextActionAt).toEqual(a.nextActionAt);
});
it("keeps, replaces and clears schedules explicitly and records the date-only change in the audit trail", async () => {
  const { actor, a } = await setup();
  let values = { ...emptyActivity(clock.now()), nextActionAt: "2026-10-01T10:00" };
  await saveActivityDraft(db, clock, actor, a.id, 0, values);
  await commitActivityDraft(db, clock, actor, a.id, input(values));
  let [after] = await db.select().from(assignments).where(eq(assignments.id, a.id));
  expect(after?.nextActionAt).toEqual(a.nextActionAt);
  values = { ...values, nextActionMode: "replace", nextActionAt: "2026-10-20T10:00" };
  await saveActivityDraft(db, clock, actor, a.id, 2, values);
  await commitActivityDraft(db, clock, actor, a.id, input(values, 3));
  [after] = await db.select().from(assignments).where(eq(assignments.id, a.id));
  expect(after?.nextActionAt?.toISOString()).toBe("2026-10-20T01:00:00.000Z");
  values = { ...values, nextActionMode: "clear" };
  await saveActivityDraft(db, clock, actor, a.id, 4, values);
  await commitActivityDraft(db, clock, actor, a.id, input(values, 5));
  [after] = await db.select().from(assignments).where(eq(assignments.id, a.id));
  expect(after?.nextActionAt).toBeNull();
  const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "assignment.update_by_activity"));
  expect(events.some((e) => (e.after as { nextActionAt: string | null }).nextActionAt === null)).toBe(true);
  const activities = await db.select().from(salesActivities);
  expect(activities.map((x) => x.nextActionMode).sort()).toEqual(["clear", "keep", "replace"]);
});
it("a terminal activity requires fresh confirmation, clears the schedule, and can be retried after closure", async () => {
  const { actor, a, company } = await setup();
  const values = {
    ...emptyActivity(clock.now()),
    kind: "declined" as const,
    declineKind: "do_not_contact" as const,
    recontactAfter: "2026-02-31",
  };
  await saveActivityDraft(db, clock, actor, a.id, 0, values);
  const request = input(values);
  await expect(commitActivityDraft(db, clock, actor, a.id, request)).rejects.toThrow("確認");
  const first = await commitActivityDraft(db, clock, actor, a.id, { ...request, confirmEnd: true });
  const retry = await commitActivityDraft(db, clock, actor, a.id, { ...request, confirmEnd: true });
  expect(retry.activityId).toBe(first.activityId);
  const [after] = await db.select().from(assignments).where(eq(assignments.id, a.id));
  expect(after).toMatchObject({ status: "lost", nextActionAt: null });
  const [c] = await db.select().from(companies).where(eq(companies.id, company.id));
  expect(c?.suppression).toBe("do_not_contact");
  expect(await db.select().from(salesActivities)).toHaveLength(1);
});
it("conflicted submissions neither record activity nor change next action", async () => {
  const { actor, a } = await setup();
  const values = emptyActivity(clock.now());
  await saveActivityDraft(db, clock, actor, a.id, 0, values);
  await expect(
    commitActivityDraft(db, clock, actor, a.id, input({ ...values, nextActionMode: "clear" }, 0)),
  ).rejects.toBeInstanceOf(ActivityDraftConflict);
  expect(await db.select().from(salesActivities)).toHaveLength(0);
  expect((await db.select().from(activityDrafts))[0]?.revision).toBe(1);
});
it("JST suggestions cross month boundaries correctly and impossible calendar dates are rejected", () => {
  expect(suggestedFollowUp(new Date("2026-10-31T16:00:00Z"), 1)).toBe("2026-11-02T10:00");
  expect(parseJstDateTime("2026-02-31T10:00")).toBeNull();
  expect(parseJstDateTime("2026-02-29")).toBeNull();
  expect(parseJstDateTime("2028-02-29")?.toISOString()).toBe("2028-02-28T15:00:00.000Z");
});
