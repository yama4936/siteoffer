import { assignments, auditEvents, contracts, type Db, payments, productTerms, rewards } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../common/clock.ts";
import { saveDomainPreference } from "../domain-preference/domain-preference.ts";
import {
  adjustReward,
  cancelReward,
  getRewardSummary,
  markRewardPaid,
  scheduleRewardPayment,
} from "../reward/reward.ts";
import {
  type ContractSnapshot,
  confirmContract,
  rejectContract,
  reportContract,
  startContractReview,
} from "./contract.ts";
import { listPaymentsForContract, recordPayment, updatePaymentStatus } from "./payment.ts";
import { seedBase, seedTerms } from "./test-seed.ts";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-14T00:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

// テスト内だけの値（仕様の値ではない）
const TEST_FIXED_RULE = { type: "fixed", amount: 12_345 };
const TEST_RATE_RULE = { type: "rate", basisPoints: 1500 };

async function reported() {
  const base = await seedBase(db);
  const terms = await seedTerms(db, { version: "t-1", price: 300_000, rewardRule: TEST_FIXED_RULE, monthlyFee: 5_000 });
  const r = await reportContract(db, clock, base.salesActor, {
    assignmentId: base.assignment.id,
    productTermsId: terms.id,
    proposalVersionId: base.proposalVersion.id,
    documentRef: "contracts/test-001.pdf",
    reportNote: "先方の社長と合意",
  });
  if (!r.ok) throw new Error(r.error);
  return { ...base, terms, contract: r.value };
}

describe("成約報告（営業）", () => {
  it("担当の営業本人だけが報告でき、担当は契約確認待ちになる。報告だけでは報酬は発生しない", async () => {
    const { contract, assignment } = await reported();
    expect(contract.status).toBe("reported");
    const [a] = await db.select().from(assignments).where(eq(assignments.id, assignment.id));
    expect(a!.status).toBe("contract_pending");
    expect(await db.select().from(rewards)).toHaveLength(0);
    const events = await db.select().from(auditEvents);
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["contract.report", "assignment.status_change"]),
    );
  });

  it("担当でない営業・運営は報告できない", async () => {
    const base = await seedBase(db);
    const r1 = await reportContract(db, clock, base.otherSalesActor, { assignmentId: base.assignment.id });
    expect(r1).toMatchObject({ ok: false, error: "forbidden" });
    const r2 = await reportContract(db, clock, base.opsActor, { assignmentId: base.assignment.id });
    expect(r2).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("同じ担当で2回報告できない", async () => {
    const { salesActor, assignment } = await reported();
    const r = await reportContract(db, clock, salesActor, { assignmentId: assignment.id });
    expect(r).toMatchObject({ ok: false, error: "already_reported" });
    expect(await db.select().from(contracts)).toHaveLength(1);
  });

  it("報告メモに秘密らしき値があれば保存しない", async () => {
    const base = await seedBase(db);
    const r = await reportContract(db, clock, base.salesActor, {
      assignmentId: base.assignment.id,
      reportNote: "移管コード: Xy7#kP2q!Lm",
    });
    expect(r).toMatchObject({ ok: false, error: "secret_like_value" });
    expect(JSON.stringify(r)).not.toContain("Xy7#kP2q!Lm");
    expect(await db.select().from(contracts)).toHaveLength(0);
  });
});

describe("契約確認（運営）と報酬の発生（AC-15）", () => {
  it("営業は契約確認できない（自分の報告でも）", async () => {
    const { salesActor, otherSalesActor, contract } = await reported();
    expect(await confirmContract(db, clock, salesActor, { contractId: contract.id })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await confirmContract(db, clock, otherSalesActor, { contractId: contract.id })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    const [c] = await db.select().from(contracts).where(eq(contracts.id, contract.id));
    expect(c!.status).toBe("reported");
    expect(await db.select().from(rewards)).toHaveLength(0);
  });

  it("確認で契約完了・スナップショット保存・報酬1件・担当完了になる", async () => {
    const { opsActor, contract, assignment, terms, proposalVersion, sales } = await reported();
    await startContractReview(db, clock, opsActor, { contractId: contract.id });
    const r = await confirmContract(db, clock, opsActor, { contractId: contract.id });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.alreadyCompleted).toBe(false);
    expect(r.value.contract.status).toBe("completed");
    expect(r.value.reward).toMatchObject({ amount: 12_345, status: "accrued", userId: sales.id });

    const snap = r.value.contract.snapshot as ContractSnapshot;
    expect(snap.terms).toMatchObject({ id: terms.id, version: "t-1", price: 300_000, monthlyFee: 5_000 });
    expect(snap.terms.scope).toEqual({ pages: ["top", "about"] });
    expect(snap.reward).toEqual({ rule: TEST_FIXED_RULE, amount: 12_345 });
    expect(snap.proposalVersion).toMatchObject({ id: proposalVersion.id, version: 1 });
    expect(snap.sales).toMatchObject({ userId: sales.id, assignmentId: assignment.id });
    expect(snap.documentRef).toBe("contracts/test-001.pdf");

    const [a] = await db.select().from(assignments).where(eq(assignments.id, assignment.id));
    expect(a!.status).toBe("completed");
    const actions = (await db.select().from(auditEvents)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["contract.complete", "reward.accrue"]));
  });

  it("確認を再実行しても報酬は1件のまま（冪等）", async () => {
    const { opsActor, contract } = await reported();
    const first = await confirmContract(db, clock, opsActor, { contractId: contract.id });
    const second = await confirmContract(db, clock, opsActor, { contractId: contract.id });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.alreadyCompleted).toBe(true);
    expect(second.value.reward.id).toBe(first.value.reward.id);
    expect(await db.select().from(rewards)).toHaveLength(1);
    expect((await db.select().from(auditEvents)).filter((e) => e.action === "reward.accrue")).toHaveLength(1);
  });

  it("並行して確認しても報酬は1件だけ", async () => {
    // 注意：PGliteは単一接続のため、Promise.all でもトランザクションは直列に実行される。
    // ここで確かめられるのは「後続の確認が完了済みを検出して報酬を作らない」ことと、
    // rewards.contract_id の一意制約で守られていること（下のテスト）まで。
    // 実PostgreSQLでの本当の同時実行（行ロック FOR UPDATE の効果）はDocker環境で確認する。
    const { opsActor, ops, contract } = await reported();
    const ops2 = { kind: "ops" as const, userId: ops.id };
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        confirmContract(db, clock, i % 2 ? ops2 : opsActor, { contractId: contract.id }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.value.alreadyCompleted)).toHaveLength(1);
    expect(await db.select().from(rewards)).toHaveLength(1);
  });

  it("報酬の二重発生は一意制約でも防がれる（ロジックを迂回した直接挿入）", async () => {
    const { opsActor, contract, sales } = await reported();
    await confirmContract(db, clock, opsActor, { contractId: contract.id });
    await expect(
      db.insert(rewards).values({ contractId: contract.id, userId: sales.id, amount: 1, accruedAt: clock.now() }),
    ).rejects.toThrow();
  });

  it("割合方式の報酬は価格から計算する（端数切り捨て）", async () => {
    const base = await seedBase(db);
    const terms = await seedTerms(db, { version: "rate-1", price: 333_333, rewardRule: TEST_RATE_RULE });
    const rep = await reportContract(db, clock, base.salesActor, {
      assignmentId: base.assignment.id,
      productTermsId: terms.id,
      documentRef: "contracts/rate.pdf",
    });
    if (!rep.ok) throw new Error(rep.error);
    const r = await confirmContract(db, clock, base.opsActor, { contractId: rep.value.id });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.reward.amount).toBe(49_999); // 333,333 × 15% = 49,999.95 → 49,999
  });

  it("条件未設定・契約資料なしでは確認できない", async () => {
    const base = await seedBase(db);
    const noRule = await seedTerms(db, { version: "n-1", price: 100_000, rewardRule: null });
    const rep = await reportContract(db, clock, base.salesActor, { assignmentId: base.assignment.id });
    if (!rep.ok) throw new Error(rep.error);
    expect(
      await confirmContract(db, clock, base.opsActor, { contractId: rep.value.id, productTermsId: noRule.id }),
    ).toMatchObject({ ok: false, error: "document_required" });
    expect(
      await confirmContract(db, clock, base.opsActor, {
        contractId: rep.value.id,
        productTermsId: noRule.id,
        documentRef: "contracts/x.pdf",
      }),
    ).toMatchObject({ ok: false, error: "terms_not_ready" });
    expect(
      await confirmContract(db, clock, base.opsActor, { contractId: rep.value.id, documentRef: "contracts/x.pdf" }),
    ).toMatchObject({ ok: false, error: "terms_not_found" });
    expect(await db.select().from(rewards)).toHaveLength(0);
  });

  it("差し戻した報告は確認できず、担当は商談中に戻り、再報告できる", async () => {
    const { opsActor, salesActor, contract, assignment } = await reported();
    const rej = await rejectContract(db, clock, opsActor, { contractId: contract.id, reason: "資料不備" });
    expect(rej.ok).toBe(true);
    expect(await confirmContract(db, clock, opsActor, { contractId: contract.id })).toMatchObject({
      ok: false,
      error: "invalid_state",
    });
    const [a] = await db.select().from(assignments).where(eq(assignments.id, assignment.id));
    expect(a!.status).toBe("negotiating");
    const again = await reportContract(db, clock, salesActor, { assignmentId: assignment.id });
    expect(again.ok).toBe(true);
  });
});

describe("スナップショットの不変性（AC-16）", () => {
  it("販売条件・報酬条件・ドメイン希望を後で変えても、既存契約のスナップショットと報酬額は変わらない", async () => {
    const base = await seedBase(db);
    const terms = await seedTerms(db, { version: "s-1", price: 200_000, rewardRule: TEST_FIXED_RULE });
    const dp = await saveDomainPreference(db, clock, base.salesActor, {
      companyId: base.company.id,
      assignmentId: base.assignment.id,
      intent: "keep",
      currentDomain: "example-koumuten.jp",
      usesEmail: "yes",
      currentManager: "vendor",
    });
    expect(dp.ok).toBe(true);
    const rep = await reportContract(db, clock, base.salesActor, {
      assignmentId: base.assignment.id,
      productTermsId: terms.id,
      documentRef: "contracts/s.pdf",
    });
    if (!rep.ok) throw new Error(rep.error);
    const conf = await confirmContract(db, clock, base.opsActor, { contractId: rep.value.id });
    if (!conf.ok) throw new Error(conf.error);
    const snapBefore = structuredClone(conf.value.contract.snapshot);
    expect((snapBefore as ContractSnapshot).domain).toMatchObject({
      intent: "keep",
      currentDomain: "example-koumuten.jp",
      usesEmail: "yes",
    });

    await db
      .update(productTerms)
      .set({ price: 999_999, rewardRule: { type: "fixed", amount: 1 }, scope: { pages: ["changed"] } })
      .where(eq(productTerms.id, terms.id));
    await saveDomainPreference(db, clock, base.opsActor, {
      companyId: base.company.id,
      assignmentId: base.assignment.id,
      intent: "new",
      newDomainCandidates: ["changed.example"],
    });
    // 再確認しても上書きされない
    await confirmContract(db, clock, base.opsActor, { contractId: rep.value.id });

    const [c] = await db.select().from(contracts).where(eq(contracts.id, rep.value.id));
    expect(c!.snapshot).toEqual(snapBefore);
    const [rw] = await db.select().from(rewards).where(eq(rewards.contractId, rep.value.id));
    expect(rw!.amount).toBe(12_345);
  });
});

describe("入金と報酬支払いは別に記録される（AC-16）", () => {
  it("入金の状態と報酬の状態は互いに影響しない", async () => {
    const { opsActor, salesActor, contract } = await reported();
    const conf = await confirmContract(db, clock, opsActor, { contractId: contract.id });
    if (!conf.ok) throw new Error(conf.error);
    const rewardId = conf.value.reward.id;

    // 入金はまだ。報酬は発生済みのまま支払予定・支払済みにできる（入金を条件にしない：14章）
    const pay = await recordPayment(db, clock, opsActor, { contractId: contract.id, amount: 300_000 });
    if (!pay.ok) throw new Error(pay.error);
    expect(pay.value.status).toBe("pending");
    expect(
      (await scheduleRewardPayment(db, clock, opsActor, { rewardId, scheduledFor: new Date("2026-11-30") })).ok,
    ).toBe(true);
    expect((await markRewardPaid(db, clock, opsActor, { rewardId })).ok).toBe(true);

    // 入金を受領→返金しても、報酬の記録は変わらない
    clock.advance(1000);
    expect((await updatePaymentStatus(db, clock, opsActor, { paymentId: pay.value.id, status: "received" })).ok).toBe(
      true,
    );
    expect((await updatePaymentStatus(db, clock, opsActor, { paymentId: pay.value.id, status: "refunded" })).ok).toBe(
      true,
    );

    const [p] = await listPaymentsForContract(db, contract.id);
    expect(p).toMatchObject({ status: "refunded", amount: 300_000 });
    expect(p!.receivedAt).not.toBeNull();
    const summary = await getRewardSummary(db, rewardId);
    expect(summary!.reward.status).toBe("paid");
    expect(summary!.reward.paidAt).not.toBeNull();
    expect(summary!.currentAmount).toBe(12_345);
    expect(await db.select().from(payments)).toHaveLength(1);

    // 営業は入金・報酬の操作ができない
    expect(await recordPayment(db, clock, salesActor, { contractId: contract.id, amount: 1 })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  });

  it("未完了の契約には入金を登録できない", async () => {
    const { opsActor, contract } = await reported();
    expect(await recordPayment(db, clock, opsActor, { contractId: contract.id, amount: 1000 })).toMatchObject({
      ok: false,
      error: "invalid_state",
    });
  });
});

describe("報酬の調整・取り消し（元の記録を消さない）", () => {
  it("調整と取り消しは reward_adjustments に残り、rewards.amount は発生時の額のまま", async () => {
    const { opsActor, salesActor, contract } = await reported();
    const conf = await confirmContract(db, clock, opsActor, { contractId: contract.id });
    if (!conf.ok) throw new Error(conf.error);
    const rewardId = conf.value.reward.id;

    expect(await adjustReward(db, clock, salesActor, { rewardId, delta: 100, reason: "x" })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    const adj = await adjustReward(db, clock, opsActor, { rewardId, delta: -2_345, reason: "条件の訂正（テスト）" });
    if (!adj.ok) throw new Error(adj.error);
    expect(adj.value.currentAmount).toBe(10_000);
    expect(await adjustReward(db, clock, opsActor, { rewardId, delta: -20_000, reason: "負" })).toMatchObject({
      ok: false,
      error: "invalid_input",
    });

    const cancel = await cancelReward(db, clock, opsActor, { rewardId, reason: "解約（テスト）" });
    if (!cancel.ok) throw new Error(cancel.error);
    expect(cancel.value.reward.status).toBe("cancelled");
    expect(cancel.value.reward.amount).toBe(12_345);
    expect(cancel.value.currentAmount).toBe(0);
    expect(cancel.value.adjustments.map((a) => [a.kind, a.delta])).toEqual([
      ["amount_change", -2_345],
      ["cancellation", -10_000],
    ]);
    // 取り消し後は支払予定にできない
    expect(
      await scheduleRewardPayment(db, clock, opsActor, { rewardId, scheduledFor: new Date("2026-12-01") }),
    ).toMatchObject({ ok: false, error: "invalid_state" });
  });
});
