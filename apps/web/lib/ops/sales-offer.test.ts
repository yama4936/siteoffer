import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type ContractSnapshot,
  claimAssignment,
  confirmContract,
  fixedClock,
  getSalesOffer,
  reassignAssignment,
  reportContract,
} from "@siteoffer/core";
import {
  assignments,
  auditEvents,
  companies,
  contracts,
  type Db,
  productTerms,
  proposals,
  proposalVersions,
  rewards,
  salesOffers,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getCompanyDetail, getMyAssignmentDetail } from "../sales/queries";
import { makeSellable, withdrawSellable } from "./commands";
import { seedTerms, seedUser } from "./test-seed";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
async function setup(publish = true) {
  const ops = (await seedUser(db, "ops")).actor,
    sales = (await seedUser(db, "sales")).actor;
  const [c] = await db
    .insert(companies)
    .values({ name: "架空・販売条件固定", pipelineStatus: "in_review", officialSiteStatus: "confirmed" })
    .returning();
  const [p] = await db.insert(proposals).values({ companyId: c!.id }).returning();
  const [v] = await db
    .insert(proposalVersions)
    .values({ proposalId: p!.id, version: 1, status: "approved" })
    .returning();
  const a = await seedTerms(db, {
    version: randomUUID(),
    price: 123456,
    monthlyFee: 5000,
    rewardRule: { type: "fixed", amount: 12345 },
  });
  const b = await seedTerms(db, {
    version: randomUUID(),
    price: 999999,
    monthlyFee: 9000,
    rewardRule: { type: "fixed", amount: 99999 },
  });
  const input = { companyId: c!.id, productTermsId: a.id, expectedProposalVersionId: v!.id, allowExisting: true };
  if (publish) expect(await makeSellable({ db, clock }, ops, input)).toMatchObject({ ok: true });
  return { ops, sales, c: c!, p: p!, v: v!, a, b, input };
}
async function assigned() {
  const s = await setup();
  const r = await claimAssignment(db, clock, s.sales, s.c.id);
  if (!r.ok) throw Error(r.error);
  return { ...s, assignment: r.value };
}
async function republish(s: Awaited<ReturnType<typeof setup>>) {
  expect(await withdrawSellable({ db, clock }, s.ops, { companyId: s.c.id, reason: "架空検証：新版" })).toMatchObject({
    ok: true,
  });
  const [v] = await db
    .insert(proposalVersions)
    .values({ proposalId: s.p.id, version: 2, status: "approved" })
    .returning();
  expect(
    await makeSellable({ db, clock }, s.ops, { ...s.input, productTermsId: s.b.id, expectedProposalVersionId: v!.id }),
  ).toMatchObject({ ok: true });
  return v!;
}
it("公開条件を保存し、同じ確定の再試行では引き継ぎ版を増やさない", async () => {
  const s = await setup();
  expect(await makeSellable({ db, clock }, s.ops, s.input)).toMatchObject({ ok: true });
  expect(await db.select().from(salesOffers)).toMatchObject([
    { companyId: s.c.id, version: 1, productTermsId: s.a.id, proposalVersionId: s.v.id },
  ]);
  const d = await getCompanyDetail(db, s.sales, s.c.id);
  expect(d.ok && d.value.terms.map((t) => t.id)).toEqual([s.a.id]);
  expect(d.ok && d.value.showClaim).toBe(true);
});
it("担当確保時の提案と条件を固定し、再公開後も進行中商談は元の版を表示する", async () => {
  const s = await assigned();
  const v2 = await republish(s);
  const owner = await getCompanyDetail(db, s.sales, s.c.id);
  expect(owner.ok && owner.value.terms.map((t) => t.id)).toEqual([s.a.id]);
  expect(owner.ok && owner.value.proposal?.versionId).toBe(s.v.id);
  const other = (await seedUser(db, "sales")).actor;
  const visitor = await getCompanyDetail(db, other, s.c.id);
  expect(visitor.ok && visitor.value.terms.map((t) => t.id)).toEqual([s.b.id]);
  expect(visitor.ok && visitor.value.proposal?.versionId).toBe(v2.id);
  const detail = await getMyAssignmentDetail(db, s.sales, s.assignment.id);
  expect(detail.ok && detail.value.salesOfferId).toBe(s.assignment.salesOfferId);
  expect(detail.ok && detail.value.terms.map((t) => t.id)).toEqual([s.a.id]);
  expect(detail.ok && detail.value.proposalVersionId).toBe(s.v.id);
  const reported = await reportContract(db, clock, s.sales, {
    assignmentId: s.assignment.id,
    documentRef: "架空契約.pdf",
  });
  expect(reported).toMatchObject({
    ok: true,
    value: { salesOfferId: s.assignment.salesOfferId, productTermsId: s.a.id, proposalVersionId: s.v.id },
  });
});
it("別商品・別提案版・別引き継ぎ版を送信しても契約を作らない", async () => {
  const s = await assigned();
  const v2 = await republish(s);
  const latest = await getSalesOffer(db, s.c.id);
  for (const patch of [{ productTermsId: s.b.id }, { proposalVersionId: v2.id }, { salesOfferId: latest!.offer.id }]) {
    expect(await reportContract(db, clock, s.sales, { assignmentId: s.assignment.id, ...patch })).toMatchObject({
      ok: false,
      error: "offer_mismatch",
    });
  }
  expect(await db.select().from(contracts)).toHaveLength(0);
  expect((await db.select().from(assignments).where(eq(assignments.id, s.assignment.id)))[0]!.status).toBe("claimed");
});
it("販売停止した条件は新規確保を止め、既存商談の条件と報酬は維持する", async () => {
  const s = await assigned();
  await db.update(productTerms).set({ active: false }).where(eq(productTerms.id, s.a.id));
  const r = await reportContract(db, clock, s.sales, { assignmentId: s.assignment.id, documentRef: "架空契約.pdf" });
  if (!r.ok) throw Error(r.error);
  expect(await confirmContract(db, clock, s.ops, { contractId: r.value.id, productTermsId: s.b.id })).toMatchObject({
    ok: false,
    error: "offer_mismatch",
  });
  const confirmed = await confirmContract(db, clock, s.ops, { contractId: r.value.id });
  if (!confirmed.ok) throw Error(confirmed.error);
  const snapshot = confirmed.value.contract.snapshot as ContractSnapshot;
  expect(snapshot.terms).toMatchObject({ id: s.a.id, price: 123456, monthlyFee: 5000 });
  expect(snapshot.reward.amount).toBe(12345);
  expect(snapshot.proposalVersion?.id).toBe(s.v.id);
  expect(await confirmContract(db, clock, s.ops, { contractId: r.value.id })).toMatchObject({
    ok: true,
    value: { alreadyCompleted: true },
  });
  expect(await db.select().from(rewards)).toHaveLength(1);
});
it("無効な販売条件の企業を新しく確保できない", async () => {
  const s = await setup();
  await db.update(productTerms).set({ active: false }).where(eq(productTerms.id, s.a.id));
  expect(await claimAssignment(db, clock, s.sales, s.c.id)).toMatchObject({ ok: false, error: "offer_not_ready" });
  const d = await getCompanyDetail(db, s.sales, s.c.id);
  expect(d.ok && d.value.showClaim).toBe(false);
});
it("営業可能フラグだけの旧企業は運営の条件確認まで確保できない", async () => {
  const s = await setup(false);
  await db.update(companies).set({ pipelineStatus: "sellable" }).where(eq(companies.id, s.c.id));
  expect(await claimAssignment(db, clock, s.sales, s.c.id)).toMatchObject({ ok: false, error: "offer_not_ready" });
  expect(await makeSellable({ db, clock }, s.ops, s.input)).toMatchObject({ ok: true });
  expect(await claimAssignment(db, clock, s.sales, s.c.id)).toMatchObject({ ok: true });
});
it("運営による担当変更でも元の引き継ぎ条件を保持する", async () => {
  const s = await assigned();
  await republish(s);
  const other = (await seedUser(db, "sales")).actor;
  const r = await reassignAssignment(db, clock, s.ops, {
    assignmentId: s.assignment.id,
    toUserId: other.userId,
    reason: "架空検証",
  });
  expect(r).toMatchObject({ ok: true, value: { created: { salesOfferId: s.assignment.salesOfferId } } });
});
it("旧担当への条件補完は画面で確認した引き継ぎ版を照合してから固定する", async () => {
  const s = await setup();
  const [a] = await db
    .insert(assignments)
    .values({ companyId: s.c.id, userId: s.sales.userId, claimedAt: clock.now() })
    .returning();
  const first = await getSalesOffer(db, s.c.id);
  expect(await reportContract(db, clock, s.sales, { assignmentId: a!.id })).toMatchObject({
    ok: false,
    error: "offer_mismatch",
  });
  await republish(s);
  expect(
    await reportContract(db, clock, s.sales, { assignmentId: a!.id, salesOfferId: first!.offer.id }),
  ).toMatchObject({ ok: false, error: "offer_mismatch" });
  const current = await getSalesOffer(db, s.c.id);
  expect(
    await reportContract(db, clock, s.sales, { assignmentId: a!.id, salesOfferId: current!.offer.id }),
  ).toMatchObject({ ok: true, value: { salesOfferId: current!.offer.id, productTermsId: s.b.id } });
});
it("監査移行は最新の根拠と担当時刻を確認し、古い・不正な記録から推測しない", async () => {
  const s = await setup(false);
  const t = new Date("2026-10-01T00:00:00Z");
  await db.insert(auditEvents).values({
    actorKind: "ops",
    actorId: s.ops.userId,
    action: "company.make_sellable",
    targetType: "company",
    targetId: s.c.id,
    after: { productTermsId: s.a.id, proposalVersionId: s.v.id },
    createdAt: t,
  });
  const [before] = await db
    .insert(assignments)
    .values({ companyId: s.c.id, userId: s.sales.userId, status: "released", claimedAt: new Date("2026-09-01") })
    .returning();
  const [after] = await db
    .insert(assignments)
    .values({ companyId: s.c.id, userId: s.sales.userId, claimedAt: new Date("2026-10-02") })
    .returning();
  const invalid = await setup(false);
  await db.insert(auditEvents).values([
    {
      actorKind: "ops",
      action: "company.make_sellable",
      targetType: "company",
      targetId: invalid.c.id,
      after: { productTermsId: invalid.a.id, proposalVersionId: invalid.v.id },
      createdAt: t,
    },
    {
      actorKind: "ops",
      action: "company.make_sellable",
      targetType: "company",
      targetId: invalid.c.id,
      after: { productTermsId: "bad", proposalVersionId: invalid.v.id },
      createdAt: new Date("2026-10-02"),
    },
  ]);
  const migration = await readFile(
    new URL("../../../../packages/db/drizzle/0026_nosy_dagger.sql", import.meta.url),
    "utf8",
  );
  const backfill = migration.slice(migration.indexOf("-- Only the latest"));
  for (const statement of backfill.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
  expect(await db.select().from(salesOffers)).toHaveLength(1);
  expect((await db.select().from(assignments).where(eq(assignments.id, before!.id)))[0]!.salesOfferId).toBeNull();
  expect((await db.select().from(assignments).where(eq(assignments.id, after!.id)))[0]!.salesOfferId).not.toBeNull();
});

it("表示後に条件が変更された場合は古い確認内容で担当確保しない", async () => {
  const s = await setup();
  const first = await getSalesOffer(db, s.c.id);
  await republish(s);
  expect(await claimAssignment(db, clock, s.sales, s.c.id, first!.offer.id)).toMatchObject({
    ok: false,
    error: "offer_changed",
  });
  expect(await db.select().from(assignments)).toHaveLength(0);
  const current = await getSalesOffer(db, s.c.id);
  expect(await claimAssignment(db, clock, s.sales, s.c.id, current!.offer.id)).toMatchObject({
    ok: true,
    value: { salesOfferId: current!.offer.id },
  });
});
