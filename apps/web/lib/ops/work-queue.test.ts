import { randomUUID } from "node:crypto";
import { confirmDomainPreference, fixedClock, saveDomainPreference, updateConsultationCase } from "@siteoffer/core";
import { seedDeliveryBase } from "@siteoffer/core/delivery/testing";
import {
  assignments,
  companies,
  contracts,
  type Db,
  deliveries,
  designVersions,
  discoveryJobs,
  domainPreferences,
  proposalVersions,
  salesActivities,
  siteAudits,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDeliveryByOps, listContractsAwaitingDelivery, listDeliveryDetails } from "./delivery";
import { listAssignmentsOverview, listContractsOverview, listDomainPreferencesForOps } from "./queries";
import { seedCandidate, seedUser } from "./test-seed";
import { getOpsWorkQueue } from "./work-queue";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
async function queue() {
  const { actor } = await seedUser(db, "ops");
  const r = await getOpsWorkQueue(db, actor);
  if (!r.ok) throw new Error("queue");
  return r.value;
}
async function design(
  companyId: string,
  auditId: string,
  version: number,
  status: "draft" | "in_review" | "approved" | "failed" | "queued" = "draft",
) {
  const [row] = await db
    .insert(designVersions)
    .values({
      companyId,
      auditId,
      version,
      status,
      requestKey: randomUUID(),
      brief: {},
      companySnapshot: {},
      prompt: "fixture",
      source: "import",
      imageBase64: "fixture-image-private",
    })
    .returning();
  return row!;
}
it("operations data is rejected before querying for non-operators", async () => {
  expect(await getOpsWorkQueue(db, null)).toMatchObject({ ok: false, error: "forbidden" });
  const { actor } = await seedUser(db, "sales");
  expect(await getOpsWorkQueue(db, actor)).toMatchObject({ ok: false, error: "forbidden" });
});
it("a retry chain only exposes the unresolved leaf; historical failures are not counted", async () => {
  const [old] = await db
    .insert(discoveryJobs)
    .values({ provider: "fixture", criteria: {}, status: "failed" })
    .returning();
  const [retry] = await db
    .insert(discoveryJobs)
    .values({ provider: "fixture", criteria: {}, status: "queued", retryOfJobId: old!.id })
    .returning();
  expect((await queue()).items).toEqual([]);
  await db.update(discoveryJobs).set({ status: "failed" }).where(eq(discoveryJobs.id, retry!.id));
  const q = await queue();
  expect(q.total).toBe(1);
  expect(q.items[0]?.id).toBe(retry!.id);
});
it("only latest actionable design versions are visible; in-flight and suppressed work is excluded", async () => {
  const c = await seedCandidate(db, { versionStatus: null });
  await design(c.company.id, c.audit.id, 1, "failed");
  const latest = await design(c.company.id, c.audit.id, 2, "approved");
  const q = await queue();
  expect(q.items).toHaveLength(1);
  expect(q.items[0]).toMatchObject({ id: latest.id, action: "制作へ進む" });
  expect(JSON.stringify(q)).not.toContain("fixture-image-private");
  await db.update(designVersions).set({ buildRequestedAt: new Date() }).where(eq(designVersions.id, latest.id));
  expect((await queue()).items).toHaveLength(0);
  await design(c.company.id, c.audit.id, 3, "queued");
  expect((await queue()).items).toHaveLength(0);
  await design(c.company.id, c.audit.id, 4, "in_review");
  await db.update(companies).set({ suppression: "do_not_contact" }).where(eq(companies.id, c.company.id));
  expect((await queue()).items).toHaveLength(0);
});
it("superseded proposal reviews move to sales readiness after approval", async () => {
  const c = await seedCandidate(db);
  expect((await queue()).items.some((i) => i.id === c.version!.id)).toBe(true);
  await db
    .insert(proposalVersions)
    .values({ proposalId: c.proposal.id, version: 2, status: "approved", auditId: c.audit.id });
  expect((await queue()).items).toMatchObject([{ group: "sales_ready", id: c.company.id }]);
  await db.update(companies).set({ pipelineStatus: "sellable" }).where(eq(companies.id, c.company.id));
  // A legacy sellable flag alone does not prove which offer was handed off.
  expect((await queue()).items).toMatchObject([{ group: "sales_ready", id: c.company.id }]);
});
it("preparation only includes eligible companies and moves to design when started", async () => {
  const c = await seedCandidate(db, { versionStatus: null });
  await db.update(companies).set({ pipelineStatus: "audited" }).where(eq(companies.id, c.company.id));
  expect((await queue()).items).toHaveLength(0);
  await db.update(siteAudits).set({ decision: "create" }).where(eq(siteAudits.id, c.audit.id));
  expect((await queue()).items[0]).toMatchObject({ group: "preparation", title: c.company.name });
  await design(c.company.id, c.audit.id, 1);
  expect((await queue()).items.map((i) => i.group)).toEqual(["design"]);
});
it("counts include all rows beyond the display limit and stopped work comes first", async () => {
  await db.insert(discoveryJobs).values(
    Array.from({ length: 24 }, (_, i) => ({
      provider: "fixture",
      criteria: {},
      status: "failed" as const,
      createdAt: new Date(2026, 0, 1 + i),
    })),
  );
  const q = await queue();
  expect(q.total).toBe(24);
  expect(q.groups.find((g) => g.key === "discovery")?.count).toBe(24);
  expect(q.items).toHaveLength(20);
  expect(q.items[0]?.since).toBe(new Date(2026, 0, 1).toISOString());
});
it("focused handoff links return precisely the requested assignment, contract and delivery", async () => {
  const { actor: ops } = await seedUser(db, "ops");
  const { user } = await seedUser(db, "sales");
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const c = await seedCandidate(db, { versionStatus: null });
    const [a] = await db
      .insert(assignments)
      .values({ companyId: c.company.id, userId: user.id, status: "awaiting_ops", claimedAt: new Date() })
      .returning();
    const [contract] = await db
      .insert(contracts)
      .values({
        companyId: c.company.id,
        assignmentId: a!.id,
        salesUserId: user.id,
        status: "completed",
        reportedAt: new Date(),
      })
      .returning();
    const [d] = await db.insert(deliveries).values({ contractId: contract!.id, status: "ops_review" }).returning();
    ids.push({ a: a!.id, c: contract!.id, d: d!.id });
  }
  const id = ids[0]!;
  const a = await listAssignmentsOverview(db, ops, { id: id.a });
  expect(a.ok && a.value.map((r) => r.a.id)).toEqual([id.a]);
  const c = await listContractsOverview(db, ops, { id: id.c });
  expect(c.ok && c.value.map((r) => r.c.id)).toEqual([id.c]);
  const d = await listDeliveryDetails(db, ops, { id: id.d });
  expect(d.ok && d.value.map((r) => r.delivery.id)).toEqual([id.d]);
  const q = await queue();
  expect(q.items.find((i) => i.id === id.d)?.href).toContain(`?focus=${id.d}#delivery-${id.d}`);
  const { actor: sales } = await seedUser(db, "sales");
  expect(await listDeliveryDetails(db, sales, { id: id.d })).toMatchObject({ ok: false, error: "forbidden" });
});

it("未着手の契約を表示し、着手後は同じ納品へ移る。契約取消は表示しない", async () => {
  const b = await seedDeliveryBase(db);
  const q = await getOpsWorkQueue(db, b.ops);
  expect(q.ok && q.value.items.find((i) => i.id === b.contract.id)).toMatchObject({
    group: "delivery_start",
    href: `/ops/delivery?contract=${b.contract.id}#contract-start-${b.contract.id}`,
  });
  const created = await createDeliveryByOps({ db, clock: fixedClock("2026-10-16T00:00:00Z") }, b.ops, b.contract.id);
  if (!created.ok) throw new Error(created.error);
  const next = await getOpsWorkQueue(db, b.ops);
  expect(next.ok && next.value.items.some((i) => i.id === b.contract.id)).toBe(false);
  expect(next.ok && next.value.items.some((i) => i.id === created.value.deliveryId && i.group === "delivery")).toBe(
    true,
  );
  const existing = await listDeliveryDetails(db, b.ops, { contractId: b.contract.id });
  expect(existing.ok && existing.value.map((d) => d.delivery.id)).toEqual([created.value.deliveryId]);
  await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, b.contract.id));
  const cancelled = await getOpsWorkQueue(db, b.ops);
  expect(
    cancelled.ok && cancelled.value.items.some((i) => i.group === "delivery" || i.group === "delivery_start"),
  ).toBe(false);
});

it("公開記録後の納品確認を表示し、完了後は消える", async () => {
  const b = await seedDeliveryBase(db);
  const [d] = await db.insert(deliveries).values({ contractId: b.contract.id, status: "published" }).returning();
  const q = await getOpsWorkQueue(db, b.ops);
  expect(q.ok && q.value.items.find((i) => i.id === d!.id)?.reason).toContain("実際の公開状況");
  await db.update(deliveries).set({ status: "delivered" }).where(eq(deliveries.id, d!.id));
  const done = await getOpsWorkQueue(db, b.ops);
  expect(done.ok && done.value.items.some((i) => i.id === d!.id)).toBe(false);
});

it("未確認ドメインは担当終了・営業抑止後も残り、確認で消えて変更で再表示される", async () => {
  const b = await seedDeliveryBase(db);
  await db.update(companies).set({ suppression: "do_not_contact" }).where(eq(companies.id, b.company.id));
  const clock = fixedClock("2026-10-16T00:00:00Z");
  const input = { companyId: b.company.id, assignmentId: b.contract.assignmentId, intent: "keep" as const };
  const saved = await saveDomainPreference(db, clock, b.ops, input);
  if (!saved.ok) throw new Error(saved.error);
  const p = saved.value.preference;
  const q = await getOpsWorkQueue(db, b.ops);
  expect(q.ok && q.value.items.find((i) => i.id === p.id)).toMatchObject({
    group: "domain",
    href: `/ops/delivery?domain=${p.id}#domain-${p.id}`,
  });
  expect((await confirmDomainPreference(db, clock, b.ops, { id: p.id, revision: p.revision })).ok).toBe(true);
  const done = await getOpsWorkQueue(db, b.ops);
  expect(done.ok && done.value.items.some((i) => i.id === p.id)).toBe(false);
  await saveDomainPreference(db, clock, b.ops, { ...input, usesEmail: "yes" });
  const again = await getOpsWorkQueue(db, b.ops);
  expect(again.ok && again.value.items.some((i) => i.id === p.id)).toBe(true);
  expect(await listDomainPreferencesForOps(db, b.sales, { id: p.id })).toMatchObject({ ok: false, error: "forbidden" });
  expect(await listContractsAwaitingDelivery(db, b.sales, { id: b.contract.id })).toMatchObject({
    ok: false,
    error: "forbidden",
  });
});

it("200件以上でも古い未確認を隠さず、表示上限と総数を分け、対象を直接取得できる", async () => {
  const b = await seedDeliveryBase(db);
  const confirmed = await db
    .insert(domainPreferences)
    .values(
      Array.from({ length: 205 }, (_, i) => ({
        companyId: b.company.id,
        recordedBy: b.sales.userId,
        confirmedAt: new Date("2026-10-15T00:00:00Z"),
        updatedAt: new Date(Date.UTC(2026, 9, 15, 0, i)),
      })),
    )
    .returning();
  const pending = await db
    .insert(domainPreferences)
    .values(
      Array.from({ length: 25 }, (_, i) => ({
        companyId: b.company.id,
        recordedBy: b.sales.userId,
        customerWish: "private fixture note",
        updatedAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
      })),
    )
    .returning();
  const list = await listDomainPreferencesForOps(db, b.ops);
  expect(list.ok && list.value.slice(0, 25).map((r) => r.d.id)).toEqual(pending.map((p) => p.id));
  const target = confirmed[204]!;
  const focused = await listDomainPreferencesForOps(db, b.ops, { id: target.id });
  expect(focused.ok && focused.value.map((r) => r.d.id)).toEqual([target.id]);
  const q = await getOpsWorkQueue(db, b.ops);
  expect(q.ok && q.value.groups.find((g) => g.key === "domain")?.count).toBe(25);
  expect(q.ok && q.value.items.filter((i) => i.group === "domain").map((i) => i.id)).toEqual(
    pending.slice(0, 20).map((p) => p.id),
  );
  expect(JSON.stringify(q)).not.toContain("private fixture note");
});

it("100件を超える未着手契約でも直接リンクは件数制限に埋もれない", async () => {
  const b = await seedDeliveryBase(db);
  const extraAssignments = await db
    .insert(assignments)
    .values(
      Array.from({ length: 105 }, () => ({
        companyId: b.company.id,
        userId: b.sales.userId,
        status: "completed" as const,
        claimedAt: new Date(),
      })),
    )
    .returning();
  const extras = await db
    .insert(contracts)
    .values(
      extraAssignments.map((a, i) => ({
        companyId: b.company.id,
        assignmentId: a.id,
        salesUserId: b.sales.userId,
        status: "completed" as const,
        reportedAt: new Date("2026-10-01T00:00:00Z"),
        completedAt: new Date(Date.UTC(2026, 9, 5, 0, i)),
      })),
    )
    .returning();
  const target = extras[104]!;
  const list = await listContractsAwaitingDelivery(db, b.ops);
  expect(list.ok && list.value).toHaveLength(100);
  expect(list.ok && list.value.some((r) => r.contractId === target.id)).toBe(false);
  const focused = await listContractsAwaitingDelivery(db, b.ops, { id: target.id });
  expect(focused.ok && focused.value.map((r) => r.contractId)).toEqual([target.id]);
  const q = await getOpsWorkQueue(db, b.ops);
  expect(q.ok && q.value.groups.find((g) => g.key === "delivery_start")?.count).toBe(106);
  expect(q.ok && q.value.items.filter((i) => i.group === "delivery_start")).toHaveLength(20);
});

it("営業相談は終了した担当でも未完了を集め、回答完了で消え、追加相談で戻る", async () => {
  const b = await seedDeliveryBase(db);
  const [a] = await db
    .insert(salesActivities)
    .values({
      assignmentId: b.contract.assignmentId,
      companyId: b.company.id,
      userId: b.sales.userId,
      kind: "negotiating",
      occurredAt: new Date(),
      consultOps: true,
      note: "private consultation fixture",
    })
    .returning();
  let q = await getOpsWorkQueue(db, b.ops);
  expect(q.ok && q.value.items.find((i) => i.id === a!.id)).toMatchObject({
    group: "consultation",
    href: `/ops/consultations?focus=${a!.id}`,
  });
  expect(JSON.stringify(q)).not.toContain("private consultation fixture");
  const clock = fixedClock("2026-10-16T00:00:00Z");
  expect(
    (
      await updateConsultationCase(db, clock, b.ops, {
        activityId: a!.id,
        revision: 0,
        operation: "resolve",
        note: "回答しました",
        requestKey: randomUUID(),
      })
    ).ok,
  ).toBe(true);
  q = await getOpsWorkQueue(db, b.ops);
  expect(q.ok && q.value.items.some((i) => i.id === a!.id)).toBe(false);
  expect(
    (
      await updateConsultationCase(db, clock, b.sales, {
        activityId: a!.id,
        revision: 1,
        operation: "follow_up",
        note: "追加で確認します",
        requestKey: randomUUID(),
      })
    ).ok,
  ).toBe(true);
  q = await getOpsWorkQueue(db, b.ops);
  expect(q.ok && q.value.items.some((i) => i.id === a!.id)).toBe(true);
});
