import { randomUUID } from "node:crypto";
import {
  claimAssignment,
  confirmContract,
  decideSalesOfferChange,
  fixedClock,
  getOfferChangeContext,
  getSalesOffer,
  issueShareLink,
  proposeSalesOfferChange,
  reassignAssignment,
  recordActivity,
  rejectContract,
  releaseAssignment,
  releaseExpiredAssignments,
  reportContract,
  suppressCompany,
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
  salesOfferChanges,
  salesOffers,
  shareLinks,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getOfferChangeView } from "../offer-changes";
import { assignmentNextStep } from "../sales/priorities";
import { listMyAssignments } from "../sales/queries";
import { makeSellable, withdrawSellable } from "./commands";
import { seedTerms, seedUser } from "./test-seed";

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
    .values({ name: "架空・条件再交渉", officialSiteStatus: "confirmed", pipelineStatus: "in_review" })
    .returning();
  const [p] = await db.insert(proposals).values({ companyId: c!.id }).returning();
  const [v] = await db
    .insert(proposalVersions)
    .values({ proposalId: p!.id, version: 1, status: "approved", demoArtifactDir: "fixture" })
    .returning();
  const a = await seedTerms(db, {
    version: randomUUID(),
    price: 300000,
    monthlyFee: 5000,
    rewardRule: { type: "fixed", amount: 30000 },
  });
  const b = await seedTerms(db, {
    version: randomUUID(),
    price: 250000,
    monthlyFee: 4000,
    rewardRule: { type: "fixed", amount: 25000 },
  });
  must(
    await makeSellable({ db, clock }, ops, {
      companyId: c!.id,
      productTermsId: a.id,
      expectedProposalVersionId: v!.id,
    }),
  );
  const assignment = must(await claimAssignment(db, clock, sales, c!.id));
  const [v2] = await db
    .insert(proposalVersions)
    .values({ proposalId: p!.id, version: 2, status: "approved", demoArtifactDir: "fixture" })
    .returning();
  const input = {
    requestId: randomUUID(),
    assignmentId: assignment.id,
    expectedOfferId: assignment.salesOfferId!,
    productTermsId: b.id,
    proposalVersionId: v2!.id,
    reason: "提供範囲を調整したため",
  };
  return { ops, sales, other, c: c!, p: p!, v: v!, v2: v2!, a, b, assignment, input };
}
it("個別提案は公開条件を変更せず、同じ受付の再送を一件にまとめる", async () => {
  const s = await setup();
  const first = must(await proposeSalesOfferChange(db, clock, s.ops, s.input));
  expect(must(await proposeSalesOfferChange(db, clock, s.ops, s.input)).id).toBe(first.id);
  expect(await db.select().from(salesOfferChanges)).toHaveLength(1);
  expect((await getSalesOffer(db, s.c.id))?.offer.id).toBe(s.assignment.salesOfferId);
  expect((await getSalesOffer(db, s.c.id, first.toOfferId))?.offer.isPublic).toBe(false);
  expect(await proposeSalesOfferChange(db, clock, s.ops, { ...s.input, reason: "別の内容" })).toMatchObject({
    ok: false,
    error: "operation_conflict",
  });
  expect(await proposeSalesOfferChange(db, clock, s.ops, { ...s.input, requestId: randomUUID() })).toMatchObject({
    ok: false,
    error: "change_pending",
  });
});
it("確認待ちは担当一覧で優先し、成約報告を止める", async () => {
  const s = await setup();
  must(await proposeSalesOfferChange(db, clock, s.ops, s.input));
  const rows = must(await listMyAssignments(db, s.sales));
  expect(rows[0]!.offerChangePending).toBe(true);
  expect(assignmentNextStep(rows[0]!, clock.now()).group).toBe("conditions");
  expect(await reportContract(db, clock, s.sales, { assignmentId: s.assignment.id })).toMatchObject({
    ok: false,
    error: "offer_change_pending",
  });
  expect(await db.select().from(contracts)).toHaveLength(0);
});
it("営業の確認後だけ切替え、旧共有リンクを停止し変更後の価格・報酬で契約する", async () => {
  const s = await setup();
  const oldLink = must(await issueShareLink(db, clock, s.sales, { purpose: "proposal", targetId: s.v.id }));
  const change = must(await proposeSalesOfferChange(db, clock, s.ops, s.input));
  expect(await decideSalesOfferChange(db, clock, s.sales, { changeId: change.id, decision: "accept" })).toMatchObject({
    ok: false,
    error: "confirmation_required",
  });
  for (let i = 0; i < 3; i++)
    must(
      await decideSalesOfferChange(db, clock, s.sales, { changeId: change.id, decision: "accept", confirmed: true }),
    );
  expect((await db.select().from(assignments).where(eq(assignments.id, s.assignment.id)))[0]!.salesOfferId).toBe(
    change.toOfferId,
  );
  expect((await db.select().from(shareLinks).where(eq(shareLinks.id, oldLink.link.id)))[0]!.revokedAt).not.toBeNull();
  expect(await issueShareLink(db, clock, s.sales, { purpose: "proposal", targetId: s.v.id })).toMatchObject({
    ok: false,
    error: "target_not_approved",
  });
  expect(await issueShareLink(db, clock, s.sales, { purpose: "proposal", targetId: s.v2.id })).toMatchObject({
    ok: true,
  });
  const c = must(await reportContract(db, clock, s.sales, { assignmentId: s.assignment.id, documentRef: "架空資料" }));
  const done = must(await confirmContract(db, clock, s.ops, { contractId: c.id }));
  expect(done.reward.amount).toBe(25000);
  expect(done.contract.productTermsId).toBe(s.b.id);
  expect(done.contract.proposalVersionId).toBe(s.v2.id);
  expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "sales_offer.change_accepted"))).toHaveLength(
    1,
  );
  expect(must(await getOfferChangeContext(db, s.sales, s.assignment.id)).blocked).toBeTruthy();
});
it.each(["decline", "cancel"] as const)(
  "%sは理由必須で元の条件を保ち、別の回答への再送は拒否する",
  async (decision) => {
    const s = await setup();
    const c = must(await proposeSalesOfferChange(db, clock, s.ops, s.input));
    const actor = decision === "cancel" ? s.ops : s.sales;
    expect(await decideSalesOfferChange(db, clock, actor, { changeId: c.id, decision })).toMatchObject({
      ok: false,
      error: "reason_required",
    });
    must(await decideSalesOfferChange(db, clock, actor, { changeId: c.id, decision, note: "再検討してください" }));
    expect((await db.select().from(assignments).where(eq(assignments.id, s.assignment.id)))[0]!.salesOfferId).toBe(
      s.assignment.salesOfferId,
    );
    expect(
      await decideSalesOfferChange(db, clock, s.sales, { changeId: c.id, decision: "accept", confirmed: true }),
    ).toMatchObject({ ok: false, error: "already_decided" });
    expect(await reportContract(db, clock, s.sales, { assignmentId: s.assignment.id })).toMatchObject({ ok: true });
  },
);
it("他人・営業の提案・運営の代理承諾・停止ユーザーを拒否し、個別条件を他人へ表示しない", async () => {
  const s = await setup();
  expect(await proposeSalesOfferChange(db, clock, s.sales, s.input)).toMatchObject({ ok: false, error: "forbidden" });
  const c = must(await proposeSalesOfferChange(db, clock, s.ops, s.input));
  for (const actor of [s.other, s.ops, null])
    expect(
      await decideSalesOfferChange(db, clock, actor, { changeId: c.id, decision: "accept", confirmed: true }),
    ).toMatchObject({ ok: false, error: "forbidden" });
  expect(await getOfferChangeView(db, s.other, s.assignment.id)).toBeNull();
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.sales.userId));
  expect(
    await decideSalesOfferChange(db, clock, s.sales, { changeId: c.id, decision: "accept", confirmed: true }),
  ).toMatchObject({ ok: false, error: "forbidden" });
});
it.each(["terms", "proposal", "suppression"])("提示後の%s変更は承諾時に再検査する", async (kind) => {
  const s = await setup();
  const c = must(await proposeSalesOfferChange(db, clock, s.ops, s.input));
  if (kind === "terms") await db.update(productTerms).set({ active: false }).where(eq(productTerms.id, s.b.id));
  if (kind === "proposal")
    await db.update(proposalVersions).set({ status: "in_review" }).where(eq(proposalVersions.id, s.v2.id));
  if (kind === "suppression")
    await db.update(companies).set({ suppression: "do_not_contact" }).where(eq(companies.id, s.c.id));
  expect(
    await decideSalesOfferChange(db, clock, s.sales, { changeId: c.id, decision: "accept", confirmed: true }),
  ).toMatchObject({ ok: false, error: "not_ready" });
  expect((await db.select().from(assignments).where(eq(assignments.id, s.assignment.id)))[0]!.salesOfferId).toBe(
    s.assignment.salesOfferId,
  );
  must(await decideSalesOfferChange(db, clock, s.ops, { changeId: c.id, decision: "cancel", note: "再確認" }));
});
it("担当変更後に旧担当の未確認変更を適用しない", async () => {
  const s = await setup();
  const c = must(await proposeSalesOfferChange(db, clock, s.ops, s.input));
  const assigned = must(
    await reassignAssignment(db, clock, s.ops, {
      assignmentId: s.assignment.id,
      toUserId: s.other.userId,
      reason: "担当変更",
    }),
  );
  expect(assigned.created.salesOfferId).toBe(s.assignment.salesOfferId);
  expect(
    await decideSalesOfferChange(db, clock, s.sales, { changeId: c.id, decision: "accept", confirmed: true }),
  ).toMatchObject({ ok: false, error: "already_decided" });
  expect(
    await decideSalesOfferChange(db, clock, s.other, { changeId: c.id, decision: "accept", confirmed: true }),
  ).toMatchObject({ ok: false, error: "forbidden" });
  expect(must(await getOfferChangeContext(db, s.other, assigned.created.id)).history).toHaveLength(0);
});
it("成約報告を差し戻してから再交渉でき、承諾後に新版で再報告する", async () => {
  const s = await setup();
  const c = must(await reportContract(db, clock, s.sales, { assignmentId: s.assignment.id }));
  expect(await proposeSalesOfferChange(db, clock, s.ops, s.input)).toMatchObject({
    ok: false,
    error: "contract_in_progress",
  });
  must(await rejectContract(db, clock, s.ops, { contractId: c.id, reason: "条件再交渉" }));
  const change = must(await proposeSalesOfferChange(db, clock, s.ops, s.input));
  must(await decideSalesOfferChange(db, clock, s.sales, { changeId: change.id, decision: "accept", confirmed: true }));
  const updated = must(await reportContract(db, clock, s.sales, { assignmentId: s.assignment.id }));
  expect(updated.productTermsId).toBe(s.b.id);
});
it("私的な条件版があっても公開の再試行は重複せず、再公開の版番号も衝突しない", async () => {
  const s = await setup();
  must(await proposeSalesOfferChange(db, clock, s.ops, { ...s.input, proposalVersionId: s.v.id }));
  await db.update(proposalVersions).set({ status: "in_review" }).where(eq(proposalVersions.id, s.v2.id));
  // 現在の最新版が変わったときは旧版を誤って再公開しない。
  expect(
    await makeSellable({ db, clock }, s.ops, {
      companyId: s.c.id,
      productTermsId: s.a.id,
      expectedProposalVersionId: s.v.id,
      allowExisting: true,
    }),
  ).toMatchObject({ ok: false, error: "proposal_changed" });
  await db.delete(proposalVersions).where(eq(proposalVersions.id, s.v2.id));
  expect(
    await makeSellable({ db, clock }, s.ops, {
      companyId: s.c.id,
      productTermsId: s.a.id,
      expectedProposalVersionId: s.v.id,
      allowExisting: true,
    }),
  ).toMatchObject({ ok: true });
  expect(await db.select().from(salesOffers)).toHaveLength(2);
  must(await withdrawSellable({ db, clock }, s.ops, { companyId: s.c.id, reason: "公開条件更新" }));
  must(
    await makeSellable({ db, clock }, s.ops, {
      companyId: s.c.id,
      productTermsId: s.b.id,
      expectedProposalVersionId: s.v.id,
    }),
  );
  expect((await getSalesOffer(db, s.c.id))?.offer.version).toBe(3);
});
it("監査保存の失敗は条件版・依頼・担当の更新をまとめて戻す", async () => {
  const s = await setup();
  await db.execute(
    sql`create function reject_change() returns trigger language plpgsql as $$ begin if NEW.action like 'sales_offer.change_%' then raise exception 'fixture'; end if; return NEW; end $$`,
  );
  await db.execute(
    sql`create trigger reject_change before insert on audit_events for each row execute function reject_change()`,
  );
  await expect(proposeSalesOfferChange(db, clock, s.ops, s.input)).rejects.toThrow();
  expect(await db.select().from(salesOffers)).toHaveLength(1);
  expect(await db.select().from(salesOfferChanges)).toHaveLength(0);
  await db.execute(sql`drop trigger reject_change on audit_events`);
  const c = must(await proposeSalesOfferChange(db, clock, s.ops, s.input));
  await db.execute(
    sql`create trigger reject_change before insert on audit_events for each row execute function reject_change()`,
  );
  await expect(
    decideSalesOfferChange(db, clock, s.sales, { changeId: c.id, decision: "accept", confirmed: true }),
  ).rejects.toThrow();
  expect((await db.select().from(assignments).where(eq(assignments.id, s.assignment.id)))[0]!.salesOfferId).toBe(
    s.assignment.salesOfferId,
  );
  expect((await db.select().from(salesOfferChanges))[0]!.status).toBe("pending");
});
it("条件の未変更・不正入力・古い版・担当解除を受付前に拒否する", async () => {
  const s = await setup();
  expect(
    await proposeSalesOfferChange(db, clock, s.ops, { ...s.input, productTermsId: s.a.id, proposalVersionId: s.v.id }),
  ).toMatchObject({ ok: false, error: "unchanged" });
  expect(await proposeSalesOfferChange(db, clock, s.ops, { ...s.input, reason: " " })).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
  expect(await proposeSalesOfferChange(db, clock, s.ops, { ...s.input, expectedOfferId: randomUUID() })).toMatchObject({
    ok: false,
    error: "offer_changed",
  });
  must(await releaseAssignment(db, clock, s.sales, { assignmentId: s.assignment.id, reason: "終了" }));
  expect(await proposeSalesOfferChange(db, clock, s.ops, s.input)).toMatchObject({
    ok: false,
    error: "contract_in_progress",
  });
});

it.each(["release", "expiry", "lost", "suppression"])(
  "%sで担当が終了すると未確認の条件変更も同じ取引で終了する",
  async (kind) => {
    const s = await setup();
    const c = must(await proposeSalesOfferChange(db, clock, s.ops, s.input));
    if (kind === "release")
      must(await releaseAssignment(db, clock, s.sales, { assignmentId: s.assignment.id, reason: "担当終了" }));
    if (kind === "expiry") {
      await db
        .update(assignments)
        .set({ expiresAt: new Date(clock.now().getTime() - 1) })
        .where(eq(assignments.id, s.assignment.id));
      await releaseExpiredAssignments(db, clock);
    }
    if (kind === "lost")
      must(await recordActivity(db, clock, s.sales, { assignmentId: s.assignment.id, kind: "lost", note: "失注" }));
    if (kind === "suppression")
      must(await suppressCompany(db, clock, s.ops, { companyId: s.c.id, kind: "do_not_contact", reason: "連絡停止" }));
    expect((await db.select().from(salesOfferChanges).where(eq(salesOfferChanges.id, c.id)))[0]).toMatchObject({
      status: "cancelled",
      responseNote: expect.any(String),
    });
    expect(
      await decideSalesOfferChange(db, clock, s.sales, { changeId: c.id, decision: "accept", confirmed: true }),
    ).toMatchObject({ ok: false, error: "already_decided" });
    expect(
      await db.select().from(auditEvents).where(eq(auditEvents.action, "sales_offer.change_cancelled")),
    ).toHaveLength(1);
  },
);
