import { randomUUID } from "node:crypto";
import { auditEvents, companies, type Db, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readAuditHistory, readAuditHistoryEvent } from "./history";
import { parseHistoryQuery } from "./history-query";
import { seedUser } from "./test-seed";

let db: Db, close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());
const query = (input: Record<string, string> = {}) => parseHistoryQuery(input)!;
function value<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw Error(r.error);
  return r.value;
}
async function fixture() {
  const { actor } = await seedUser(db, "ops");
  const [company] = await db.insert(companies).values({ name: "架空_100%製作所" }).returning();
  const [event] = await db
    .insert(auditEvents)
    .values({
      actorKind: "ops",
      actorId: actor.userId,
      action: "company.website_candidate_saved",
      targetType: "company",
      targetId: company!.id,
      createdAt: new Date("2020-01-01T00:00:00Z"),
      before: { status: "not_found" },
      after: { status: "needs_review", note: "BODY_ONLY_MUST_NOT_APPEAR" },
    })
    .returning();
  return { actor, company: company!, event: event! };
}
it("work history excludes login/logout noise while all and access views retain every original event", async () => {
  const s = await fixture();
  await db.insert(auditEvents).values(
    Array.from({ length: 45 }, (_, i) => ({
      actorKind: i % 2 ? "sales" : "ops",
      action: i % 2 ? "session.created" : "session.deleted",
      targetType: "session",
      targetId: `session-${i}`,
      createdAt: new Date("2026-10-18T10:00:00Z"),
    })),
  );
  const work = value(await readAuditHistory(db, s.actor, query()));
  expect(work).toMatchObject({ total: 1, counts: { all: 46, access: 45, work: 1 }, query: { view: "work" } });
  expect(work.items[0]?.id).toBe(s.event.id);
  const access = value(await readAuditHistory(db, s.actor, query({ view: "access", page: "2" })));
  expect(access).toMatchObject({ total: 45, pages: 3, query: { view: "access", page: 2 } });
  expect(access.items).toHaveLength(20);
  const all = value(await readAuditHistory(db, s.actor, query({ view: "all", page: "3" })));
  expect(all.total).toBe(46);
  expect(all.items.some((row) => row.id === s.event.id)).toBe(true);
  expect(await db.select({ id: auditEvents.id }).from(auditEvents)).toHaveLength(46);
});
it("range counts honor the other search filters and an empty selected range does not claim no records exist", async () => {
  const s = await fixture();
  await db.insert(auditEvents).values([
    { actorKind: "ops", actorId: s.actor.userId, action: "session.created", targetType: "session", targetId: "ops" },
    { actorKind: "sales", action: "session.deleted", targetType: "session", targetId: "sales" },
  ]);
  const selected = value(await readAuditHistory(db, s.actor, query({ view: "access", actor: "ops" })));
  expect(selected).toMatchObject({ total: 1, counts: { work: 1, access: 1, all: 2 } });
  const empty = value(await readAuditHistory(db, s.actor, query({ view: "work", q: "ログイン" })));
  expect(empty).toMatchObject({ total: 0, counts: { work: 0, access: 1, all: 1 } });
  expect(value(await readAuditHistory(db, s.actor, query({ view: "all", q: "ログイン" }))).total).toBe(1);
});
it("finds records beyond 200, pages stable ties without bodies and keeps all query filters", async () => {
  const s = await fixture();
  await db.insert(auditEvents).values(
    Array.from({ length: 250 }, (_, i) => ({
      actorKind: "system",
      action: "worker.step_succeeded",
      targetType: "worker_step",
      targetId: `step-${i}`,
      createdAt: new Date("2026-10-18T10:00:00Z"),
      after: { privateBody: "DO_NOT_SEND", huge: "x".repeat(4000) },
    })),
  );
  const first = value(await readAuditHistory(db, s.actor, query())),
    second = value(await readAuditHistory(db, s.actor, query({ page: "2" })));
  expect(first).toMatchObject({ total: 251, pages: 13, query: { page: 1 } });
  expect(first.items).toHaveLength(20);
  expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(40);
  expect(JSON.stringify(first)).not.toMatch(/DO_NOT_SEND|privateBody|before|after/);
  for (const q of ["公式サイト候補", "架空_100%", "%", "_100%", s.event.id]) {
    const result = value(
      await readAuditHistory(
        db,
        s.actor,
        query({ q, actor: "ops", targetType: "company", targetId: s.company.id, action: "company." }),
      ),
    );
    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe(s.event.id);
  }
  expect(value(await readAuditHistory(db, s.actor, query({ q: "BODY_ONLY_MUST_NOT_APPEAR" }))).total).toBe(0);
  expect(value(await readAuditHistory(db, s.actor, query({ page: "9999" }))).query.page).toBe(13);
  expect(value(await readAuditHistory(db, s.actor, query({ q: "no results", page: "5" })))).toMatchObject({
    total: 0,
    pages: 1,
    query: { page: 1 },
    items: [],
  });
});
it("Japan time includes both calendar-day edges and excludes the next day", async () => {
  const s = await fixture();
  for (const [index, time] of [
    "2026-10-17T14:59:59.999Z",
    "2026-10-17T15:00:00.000Z",
    "2026-10-18T14:59:59.999Z",
    "2026-10-18T15:00:00.000Z",
  ].entries())
    await db.insert(auditEvents).values({
      actorKind: "system",
      action: "test.time",
      targetType: "time",
      targetId: String(index),
      createdAt: new Date(time),
    });
  const found = value(
    await readAuditHistory(db, s.actor, query({ from: "2026-10-18", to: "2026-10-18", targetType: "time" })),
  );
  expect(found.items.map((row) => row.targetId).sort()).toEqual(["1", "2"]);
});
it("recognizes signed-in customers separately from customer review links", async () => {
  const s = await fixture();
  await db.insert(auditEvents).values([
    { actorKind: "customer_user", action: "content.updated", targetType: "content", targetId: "customer" },
    { actorKind: "customer", action: "review.saved", targetType: "review", targetId: "link" },
  ]);
  expect(
    value(await readAuditHistory(db, s.actor, query({ actor: "customer_user" }))).items.map((row) => row.targetId),
  ).toEqual(["customer"]);
  expect(
    value(await readAuditHistory(db, s.actor, query({ actor: "customer" }))).items.map((row) => row.targetId),
  ).toEqual(["link"]);
});
it("action prefixes treat wildcard characters literally, while invalid direct input is rejected", async () => {
  const s = await fixture();
  await db.insert(auditEvents).values({
    actorKind: "system",
    action: "test_100%.created",
    targetType: "test",
    targetId: "invalid uuid",
    after: {},
  });
  expect(value(await readAuditHistory(db, s.actor, query({ action: "test_100%" }))).total).toBe(1);
  expect(value(await readAuditHistory(db, s.actor, query({ action: "%" }))).total).toBe(0);
  expect(await readAuditHistory(db, s.actor, { ...query(), q: ["bad"] } as never)).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
  expect(await readAuditHistoryEvent(db, s.actor, "not-an-id")).toMatchObject({ ok: false, error: "invalid_input" });
  expect(await readAuditHistoryEvent(db, s.actor, randomUUID())).toMatchObject({ ok: false, error: "not_found" });
});
it("rechecks active ops for list and detail, including removed roles and suspended sessions", async () => {
  const s = await fixture(),
    sales = await seedUser(db, "sales");
  for (const actor of [null, sales.actor, { kind: "ops", userId: randomUUID() }] as const) {
    expect(await readAuditHistory(db, actor, query())).toMatchObject({ ok: false, error: "forbidden" });
    expect(await readAuditHistoryEvent(db, actor, s.event.id)).toMatchObject({ ok: false, error: "forbidden" });
  }
  for (const patch of [{ status: "suspended" as const }, { status: "active" as const, role: "sales" as const }]) {
    await db.update(users).set(patch).where(eq(users.id, s.actor.userId));
    expect(await readAuditHistory(db, s.actor, query())).toMatchObject({ ok: false, error: "forbidden" });
    expect(await readAuditHistoryEvent(db, s.actor, s.event.id)).toMatchObject({ ok: false, error: "forbidden" });
  }
});
it("loads one detail, masks secrets, bounds oversized payloads and never edits the original event", async () => {
  const s = await fixture();
  const before = { status: "old", password: "test-private-password", nested: { apiKey: "test-private-key" } };
  await db
    .update(auditEvents)
    .set({ before, after: { long: `LARGE_PAYLOAD_MUST_NOT_LEAK${"x".repeat(70_000)}` } })
    .where(eq(auditEvents.id, s.event.id));
  const detail = value(await readAuditHistoryEvent(db, s.actor, s.event.id));
  expect(detail).toMatchObject({ beforeOmitted: false, afterOmitted: true, companyName: "架空_100%製作所" });
  expect(JSON.stringify(detail)).not.toMatch(/test-private|LARGE_PAYLOAD_MUST_NOT_LEAK/);
  expect((await db.select().from(auditEvents).where(eq(auditEvents.id, s.event.id)))[0]?.before).toEqual(before);
});
