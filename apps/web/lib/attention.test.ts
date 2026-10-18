import { randomUUID } from "node:crypto";
import { fixedClock, markConsultationRead, updateConsultationCase } from "@siteoffer/core";
import {
  assignments,
  companies,
  consultationCases,
  consultationEvents,
  consultationReads,
  type Db,
  discoveryJobs,
  salesActivities,
  salesOfferChanges,
  salesOffers,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getWorkspaceAttention } from "./attention";
import { parseAttentionSummary } from "./attention-model";
import { seedCandidate, seedTerms, seedUser } from "./ops/test-seed";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-18T14:30:00Z"); // 23:30 in Japan
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
function must<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw Error(result.error);
  return result.value;
}
async function assigned(userId: string, name: string, values: Partial<typeof assignments.$inferInsert> = {}) {
  const [company] = await db.insert(companies).values({ name }).returning();
  const [assignment] = await db
    .insert(assignments)
    .values({
      companyId: company!.id,
      userId,
      status: "working",
      claimedAt: new Date("2026-10-17T00:00:00Z"),
      ...values,
    })
    .returning();
  return { company: company!, assignment: assignment! };
}
it("rejects non-workspace actors, missing users, suspended users and role impersonation", async () => {
  const { actor, user } = await seedUser(db, "sales");
  expect(await getWorkspaceAttention(db, null)).toMatchObject({ ok: false });
  expect(await getWorkspaceAttention(db, { kind: "system", job: "attention-test" })).toMatchObject({ ok: false });
  expect(await getWorkspaceAttention(db, { kind: "sales", userId: randomUUID() })).toMatchObject({ ok: false });
  expect(await getWorkspaceAttention(db, { kind: "ops", userId: user.id })).toMatchObject({ ok: false });
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
  expect(await getWorkspaceAttention(db, actor)).toMatchObject({ ok: false });
});
it("counts all unresolved operations work while returning six bounded direct links", async () => {
  const { actor } = await seedUser(db, "ops");
  await db.insert(discoveryJobs).values(
    Array.from({ length: 27 }, (_, i) => ({
      provider: "fixture",
      criteria: {},
      status: "failed" as const,
      createdAt: new Date(1000 + i),
    })),
  );
  const first = must(await getWorkspaceAttention(db, actor, clock));
  expect(first.total).toBe(27);
  expect(first.items).toHaveLength(6);
  expect(first.groups).toEqual([{ key: "discovery", label: "収集の復旧", count: 27, href: "/ops?group=discovery" }]);
  expect(new Set(first.items.map((row) => row.key)).size).toBe(6);
  expect(parseAttentionSummary(first, "ops")).toEqual(first);
  await db.update(discoveryJobs).set({ status: "succeeded" });
  expect(must(await getWorkspaceAttention(db, actor, clock))).toMatchObject({ total: 0, items: [], groups: [] });
});
it("does not notify historical failures once their retry has been accepted", async () => {
  const { actor } = await seedUser(db, "ops");
  const [old] = await db
    .insert(discoveryJobs)
    .values({ provider: "fixture", criteria: {}, status: "failed" })
    .returning();
  await db.insert(discoveryJobs).values({ provider: "fixture", criteria: {}, status: "queued", retryOfJobId: old!.id });
  expect(must(await getWorkspaceAttention(db, actor, clock)).total).toBe(0);
});
it("uses Japan midnight, excludes future/waiting/ended and other people's assignments", async () => {
  const sales = await seedUser(db, "sales"),
    other = await seedUser(db, "sales");
  await assigned(sales.user.id, "期限超過", { expiresAt: new Date("2026-10-18T14:00:00Z") });
  await assigned(sales.user.id, "今日の予定", { nextActionAt: new Date("2026-10-18T14:59:00Z") });
  await assigned(sales.user.id, "明日の予定", { nextActionAt: new Date("2026-10-18T15:00:00Z") });
  await assigned(sales.user.id, "次回予定なし");
  await assigned(sales.user.id, "確認待ち", { status: "awaiting_ops", expiresAt: new Date(0) });
  await assigned(sales.user.id, "終了した担当", { status: "released", nextActionAt: new Date(0) });
  await assigned(other.user.id, "PRIVATE OTHER", { nextActionAt: new Date(0) });
  const result = must(await getWorkspaceAttention(db, sales.actor, clock));
  expect(result.total).toBe(3);
  expect(result.items.map((row) => row.title)).toEqual(["期限超過", "今日の予定", "次回予定なし"]);
  expect(result.groups.map((row) => row.key)).toEqual(["overdue", "today", "unscheduled"]);
  expect(parseAttentionSummary(result, "sales")).toEqual(result);
  expect(JSON.stringify(result)).not.toContain("PRIVATE OTHER");
});
it("does not prompt sales contact for a suppressed company and removes completed work", async () => {
  const sales = await seedUser(db, "sales");
  const first = await assigned(sales.user.id, "抑止した企業");
  const second = await assigned(sales.user.id, "作業が残る企業");
  await db.update(companies).set({ suppression: "do_not_contact" }).where(eq(companies.id, first.company.id));
  expect(must(await getWorkspaceAttention(db, sales.actor, clock)).items.map((row) => row.title)).toEqual([
    "作業が残る企業",
  ]);
  await db.update(assignments).set({ status: "completed" }).where(eq(assignments.id, second.assignment.id));
  expect(must(await getWorkspaceAttention(db, sales.actor, clock)).total).toBe(0);
});
it("prioritizes pending sales terms and follows their response without hiding other work", async () => {
  const sales = await seedUser(db, "sales"),
    ops = await seedUser(db, "ops");
  const candidate = await seedCandidate(db);
  const terms = await seedTerms(db, { version: "attention-test", price: 1000, rewardRule: null });
  const offers = await db
    .insert(salesOffers)
    .values(
      [1, 2].map((version) => ({
        companyId: candidate.company.id,
        productTermsId: terms.id,
        proposalVersionId: candidate.version!.id,
        version,
      })),
    )
    .returning();
  const [row] = await db
    .insert(assignments)
    .values({
      companyId: candidate.company.id,
      userId: sales.user.id,
      salesOfferId: offers[0]!.id,
      status: "working",
      claimedAt: new Date(0),
    })
    .returning();
  const [change] = await db
    .insert(salesOfferChanges)
    .values({
      assignmentId: row!.id,
      salesUserId: sales.user.id,
      fromOfferId: offers[0]!.id,
      toOfferId: offers[1]!.id,
      requestedBy: ops.user.id,
      reason: "販売条件の更新",
    })
    .returning();
  await assigned(sales.user.id, "期限超過", { nextActionAt: new Date(0) });
  expect(must(await getWorkspaceAttention(db, sales.actor, clock)).items.map((item) => item.group)).toEqual([
    "conditions",
    "overdue",
  ]);
  await db.update(salesOfferChanges).set({ status: "accepted" }).where(eq(salesOfferChanges.id, change!.id));
  expect(must(await getWorkspaceAttention(db, sales.actor, clock)).items.map((item) => item.group)).toEqual([
    "overdue",
    "unscheduled",
  ]);
});
it("shows unread replies without message bodies, does not mark reads on GET, and follows read revisions", async () => {
  const sales = await seedUser(db, "sales"),
    ops = await seedUser(db, "ops");
  const base = await assigned(sales.user.id, "回答を確認する企業", { status: "awaiting_ops" });
  const [activity] = await db
    .insert(salesActivities)
    .values({
      assignmentId: base.assignment.id,
      companyId: base.company.id,
      userId: sales.user.id,
      kind: "negotiating",
      occurredAt: clock.now(),
      consultOps: true,
      note: "private question body",
    })
    .returning();
  must(
    await updateConsultationCase(db, clock, ops.actor, {
      activityId: activity!.id,
      operation: "reply",
      revision: 0,
      note: "private reply body",
      requestKey: randomUUID(),
    }),
  );
  const value = must(await getWorkspaceAttention(db, sales.actor, clock));
  expect(value.total).toBe(1);
  expect(value.items[0]).toMatchObject({ group: "consultation", href: `/sales/consultations?focus=${activity!.id}` });
  expect(JSON.stringify(value)).not.toContain("private");
  expect(await db.select().from(consultationReads)).toEqual([]);
  must(await markConsultationRead(db, clock, sales.actor, activity!.id, 1));
  expect(must(await getWorkspaceAttention(db, sales.actor, clock)).total).toBe(0);
  must(
    await updateConsultationCase(db, clock, ops.actor, {
      activityId: activity!.id,
      operation: "resolve",
      revision: 1,
      note: "resolved",
      requestKey: randomUUID(),
    }),
  );
  expect(must(await getWorkspaceAttention(db, sales.actor, clock)).total).toBe(1);
});
it("keeps the full unread count beyond the consultation page size", async () => {
  const sales = await seedUser(db, "sales"),
    ops = await seedUser(db, "ops");
  const base = await assigned(sales.user.id, "未読が多い架空案件", { status: "awaiting_ops" });
  const activities = await db
    .insert(salesActivities)
    .values(
      Array.from({ length: 35 }, () => ({
        assignmentId: base.assignment.id,
        companyId: base.company.id,
        userId: sales.user.id,
        kind: "negotiating" as const,
        occurredAt: clock.now(),
        consultOps: true,
        note: "private message",
      })),
    )
    .returning({ id: salesActivities.id });
  await db
    .insert(consultationCases)
    .values(activities.map((row) => ({ activityId: row.id, status: "resolved" as const, revision: 1 })));
  await db.insert(consultationEvents).values(
    activities.map((row, i) => ({
      activityId: row.id,
      revision: 1,
      actorId: ops.user.id,
      operation: "resolve",
      note: "private answer",
      receiptKey: randomUUID(),
      payloadHash: "private hash",
      createdAt: new Date(1000 + i),
    })),
  );
  const value = must(await getWorkspaceAttention(db, sales.actor, clock));
  expect(value.total).toBe(35);
  expect(value.items).toHaveLength(6);
  expect(value.groups[0]).toMatchObject({ count: 35, href: "/sales/consultations?status=all&unread=1" });
  expect(parseAttentionSummary(value, "sales")).toEqual(value);
});
