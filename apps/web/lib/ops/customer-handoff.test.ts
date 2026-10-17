import { randomUUID } from "node:crypto";
import {
  claimAssignment,
  confirmContract,
  decideSalesOfferChange,
  fixedClock,
  proposeSalesOfferChange,
  reassignAssignment,
  rejectContract,
  releaseAssignment,
  reportContract,
} from "@siteoffer/core";
import {
  assignments,
  auditEvents,
  companies,
  contracts,
  type Db,
  deliveries,
  generationJobs,
  proposals,
  proposalVersions,
  rewards,
  salesOffers,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getCompanyDetail, listSellableCompanies } from "../sales/queries";
import { makeSellable } from "./commands";
import { getReviewInbox } from "./review-inbox";
import { seedTerms, seedUser } from "./test-seed";
import { getOpsWorkQueue } from "./work-queue";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw Error(r.error);
  return r.value;
}
async function setup() {
  const ops = (await seedUser(db, "ops")).actor,
    sales = (await seedUser(db, "sales")).actor,
    other = (await seedUser(db, "sales")).actor;
  const [c] = await db
    .insert(companies)
    .values({
      name: "架空・契約後引き継ぎ",
      prefecture: "愛知県",
      city: "架空市",
      pipelineStatus: "in_review",
      officialSiteStatus: "confirmed",
    })
    .returning();
  const [p] = await db.insert(proposals).values({ companyId: c!.id }).returning();
  const [v] = await db
    .insert(proposalVersions)
    .values({ proposalId: p!.id, version: 1, status: "approved" })
    .returning();
  const terms = await seedTerms(db, {
    version: randomUUID(),
    price: 300000,
    rewardRule: { type: "fixed", amount: 30000 },
  });
  const input = { companyId: c!.id, productTermsId: terms.id, expectedProposalVersionId: v!.id };
  must(await makeSellable({ db, clock }, ops, input));
  const a = must(await claimAssignment(db, clock, sales, c!.id));
  const contract = must(
    await reportContract(db, clock, sales, { assignmentId: a.id, documentRef: "架空の契約資料.pdf" }),
  );
  return { ops, sales, other, c: c!, v: v!, terms, a, contract, input };
}
it("契約完了後は別の営業の候補と担当確保から除外し、元担当は契約時の提案を読める", async () => {
  const s = await setup();
  must(await confirmContract(db, clock, s.ops, { contractId: s.contract.id }));
  expect(await claimAssignment(db, clock, s.other, s.c.id)).toMatchObject({ ok: false, error: "company_contracted" });
  expect(must(await listSellableCompanies(db, s.other)).items).toHaveLength(0);
  expect(must(await listSellableCompanies(db, s.other)).options.cities).toHaveLength(0);
  expect(await getCompanyDetail(db, s.other, s.c.id)).toMatchObject({ ok: false, error: "not_found" });
  const detail = must(await getCompanyDetail(db, s.sales, s.c.id));
  expect(detail.showClaim).toBe(false);
  expect(detail.proposal?.versionId).toBe(s.v.id);
});
it("契約確定と納品の情報確認を一括保存し、再確認しても納品は一件だけ", async () => {
  const s = await setup();
  for (let i = 0; i < 3; i++) must(await confirmContract(db, clock, s.ops, { contractId: s.contract.id }));
  expect(await db.select().from(deliveries).where(eq(deliveries.contractId, s.contract.id))).toMatchObject([
    { status: "info_gathering" },
  ]);
  expect((await db.select().from(contracts).where(eq(contracts.id, s.contract.id)))[0]!.status).toBe("completed");
});

it("確認中の企業を再公開せず、差し戻し後は担当解除と候補復帰ができる", async () => {
  const s = await setup();
  expect(await makeSellable({ db, clock }, s.ops, s.input)).toMatchObject({ ok: false, error: "company_contracted" });
  expect(must(await listSellableCompanies(db, s.other)).items).toHaveLength(0);
  expect(await releaseAssignment(db, clock, s.sales, { assignmentId: s.a.id, reason: "手放す" })).toMatchObject({
    ok: false,
    error: "contract_pending",
  });
  expect(
    await reassignAssignment(db, clock, s.ops, { assignmentId: s.a.id, toUserId: s.other.userId, reason: "変更" }),
  ).toMatchObject({ ok: false, error: "contract_pending" });
  must(await rejectContract(db, clock, s.ops, { contractId: s.contract.id, reason: "再確認" }));
  must(await releaseAssignment(db, clock, s.sales, { assignmentId: s.a.id, reason: "引き継ぎ" }));
  expect(must(await listSellableCompanies(db, s.other)).items).toHaveLength(1);
  expect(must(await claimAssignment(db, clock, s.other, s.c.id)).userId).toBe(s.other.userId);
});
it("会社の工程を戻しても契約記録から再営業を防ぐ", async () => {
  const s = await setup();
  must(await confirmContract(db, clock, s.ops, { contractId: s.contract.id }));
  await db.update(companies).set({ pipelineStatus: "in_review", suppression: "none" }).where(eq(companies.id, s.c.id));
  expect(await makeSellable({ db, clock }, s.ops, s.input)).toMatchObject({ ok: false, error: "company_contracted" });
  expect(must(await getReviewInbox(db, s.ops, { view: "ready" })).items).toHaveLength(0);
  expect(must(await getOpsWorkQueue(db, s.ops)).items.some((i) => i.group === "sales_ready")).toBe(false);
});
it.each(["released", "lost", "completed"] as const)("終了した担当(%s)の古い成約報告は確定しない", async (status) => {
  const s = await setup();
  await db.update(assignments).set({ status }).where(eq(assignments.id, s.a.id));
  expect(await confirmContract(db, clock, s.ops, { contractId: s.contract.id })).toMatchObject({
    ok: false,
    error: "invalid_state",
  });
  expect(await db.select().from(rewards)).toHaveLength(0);
  expect(await db.select().from(deliveries)).toHaveLength(0);
});
it("古い別担当の契約報告が残っていても新規報告と二重確定を拒否する", async () => {
  const s = await setup();
  await db.update(assignments).set({ status: "released" }).where(eq(assignments.id, s.a.id));
  const [a] = await db
    .insert(assignments)
    .values({
      companyId: s.c.id,
      userId: s.other.userId,
      status: "working",
      claimedAt: clock.now(),
      salesOfferId: s.a.salesOfferId,
    })
    .returning();
  expect(await reportContract(db, clock, s.other, { assignmentId: a!.id })).toMatchObject({
    ok: false,
    error: "company_contracted",
  });
  // 旧データの重複報告を再現。完了済み契約があると、残りを報酬化しない。
  await db.update(contracts).set({ status: "completed" }).where(eq(contracts.id, s.contract.id));
  const [c] = await db
    .insert(contracts)
    .values({
      companyId: s.c.id,
      assignmentId: a!.id,
      salesUserId: s.other.userId,
      status: "reported",
      salesOfferId: s.a.salesOfferId,
      productTermsId: s.terms.id,
      proposalVersionId: s.v.id,
      documentRef: "重複報告.pdf",
      reportedAt: clock.now(),
    })
    .returning();
  expect(await confirmContract(db, clock, s.ops, { contractId: c!.id })).toMatchObject({
    ok: false,
    error: "company_contracted",
  });
  expect(await db.select().from(rewards)).toHaveLength(0);
});
it("納品準備の監査保存が失敗したら契約・担当・報酬も巻き戻す", async () => {
  const s = await setup();
  await db.execute(
    sql`create function reject_handoff() returns trigger language plpgsql as $$ begin if NEW.action='delivery.create' then raise exception 'fixture failure'; end if; return NEW; end $$`,
  );
  await db.execute(
    sql`create trigger reject_handoff before insert on audit_events for each row execute function reject_handoff()`,
  );
  await expect(confirmContract(db, clock, s.ops, { contractId: s.contract.id })).rejects.toThrow();
  expect((await db.select().from(contracts))[0]!.status).toBe("reported");
  expect((await db.select().from(assignments))[0]!.status).toBe("contract_pending");
  expect(await db.select().from(rewards)).toHaveLength(0);
  expect(await db.select().from(deliveries)).toHaveLength(0);
  expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "contract.complete"))).toHaveLength(0);
});
it("完了済みの旧契約を再確認すると不足した納品準備だけ補完する", async () => {
  const s = await setup();
  must(await confirmContract(db, clock, s.ops, { contractId: s.contract.id }));
  await db.delete(deliveries).where(eq(deliveries.contractId, s.contract.id));
  must(await confirmContract(db, clock, s.ops, { contractId: s.contract.id }));
  expect(await db.select().from(deliveries)).toHaveLength(1);
  expect(await db.select().from(rewards)).toHaveLength(1);
  expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "contract.complete"))).toHaveLength(1);
});
it("納品準備は今日の仕事に現れ、有料生成は開始しない", async () => {
  const s = await setup();
  must(await confirmContract(db, clock, s.ops, { contractId: s.contract.id }));
  const [d] = await db.select().from(deliveries);
  const q = must(await getOpsWorkQueue(db, s.ops));
  expect(q.items.some((i) => i.id === d!.id && i.group === "delivery")).toBe(true);
  expect(q.items.some((i) => i.group === "delivery_start")).toBe(false);
  expect(await db.select().from(generationJobs)).toHaveLength(0);
});
it("個別に変更した契約時の提案を、契約完了後も元担当だけに表示する", async () => {
  const s = await setup();
  must(await rejectContract(db, clock, s.ops, { contractId: s.contract.id, reason: "条件再交渉" }));
  const [v] = await db
    .insert(proposalVersions)
    .values({ proposalId: s.v.proposalId, version: 2, status: "approved" })
    .returning();
  const terms = await seedTerms(db, {
    version: randomUUID(),
    price: 200000,
    rewardRule: { type: "fixed", amount: 20000 },
  });
  const change = must(
    await proposeSalesOfferChange(db, clock, s.ops, {
      requestId: randomUUID(),
      assignmentId: s.a.id,
      expectedOfferId: s.a.salesOfferId!,
      productTermsId: terms.id,
      proposalVersionId: v!.id,
      reason: "再交渉",
    }),
  );
  must(await decideSalesOfferChange(db, clock, s.sales, { changeId: change.id, decision: "accept", confirmed: true }));
  const c = must(await reportContract(db, clock, s.sales, { assignmentId: s.a.id, documentRef: "再交渉.pdf" }));
  must(await confirmContract(db, clock, s.ops, { contractId: c.id }));
  const d = must(await getCompanyDetail(db, s.sales, s.c.id));
  expect(d.proposal?.versionId).toBe(v!.id);
  expect(d.myAssignmentId).toBe(s.a.id);
  expect(d.showClaim).toBe(false);
  expect((await db.select().from(salesOffers).where(eq(salesOffers.id, d.salesOfferId!)))[0]!.isPublic).toBe(false);
  expect(await getCompanyDetail(db, s.other, s.c.id)).toMatchObject({ ok: false, error: "not_found" });
});
