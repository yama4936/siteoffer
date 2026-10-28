import { type Actor, fixedClock, getSetting } from "@siteoffer/core";
import {
  assignments,
  auditEvents,
  companies,
  contracts,
  type Db,
  discoveryJobs,
  imageAssets,
  proposalVersions,
  rewards,
  workerRuntimes,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adjustRewardByOps,
  confirmContractByOps,
  createDiscoveryJobByOps,
  createImageAsset,
  createProductTermsVersion,
  excludeCandidate,
  extendAssignmentByOps,
  liftSuppressionByOps,
  makeSellable,
  type OpsDeps,
  reassignAssignmentByOps,
  recordPaymentByOps,
  rejectContractByOps,
  releaseAssignmentByOps,
  reviewProposalVersion,
  setOfficialSiteStatus,
  setProductTermsActive,
  suspendSalesUser,
  updateCandidate,
  updateImageAssetPolicy,
  updateSetting,
  withdrawSellable,
} from "./commands";
import {
  getCompanyDetail,
  getOpsDashboard,
  getSettingsForOps,
  listAssignmentsOverview,
  listAuditEventsForOps,
  listCompanies,
  listConsultations,
  listContractsOverview,
  listDiscoveryJobs,
  listDomainPreferencesForOps,
  listReviewQueue,
  listUsersForOps,
} from "./queries";
import { sellableIssues } from "./sellable";
import { seedCandidate, seedTerms, seedUser, testPrecheck } from "./test-seed";

// テスト内だけの値（仕様の値ではない）
const TEST_RULE = { type: "fixed", amount: 10_000 };

let db: Db;
let close: () => Promise<void>;
let deps: OpsDeps;
const clock = fixedClock("2026-10-14T00:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  deps = { db, clock };
});
afterEach(async () => {
  await close();
});

async function eventCount(action: string) {
  return (await db.select().from(auditEvents).where(eq(auditEvents.action, action))).length;
}

describe("営業ユーザー・未ログイン・system は運営の処理と読み取りを呼べない（AC-17）", () => {
  it("すべての運営の処理が forbidden を返し、何も変えない", async () => {
    const { actor: sales } = await seedUser(db, "sales");
    const { user: other } = await seedUser(db, "sales");
    const terms = await seedTerms(db, { version: "t-1", price: 300_000, rewardRule: TEST_RULE });
    const { company, version } = await seedCandidate(db, { versionStatus: "approved" });
    const [a] = await db
      .insert(assignments)
      .values({ companyId: company.id, userId: other.id, status: "awaiting_ops", claimedAt: clock.now() })
      .returning();
    const before = (await db.select().from(auditEvents)).length;

    const actors: (Actor | null)[] = [
      sales,
      null,
      { kind: "system", job: "x" },
      { kind: "customer", shareLinkId: "s" },
    ];
    for (const actor of actors) {
      const results = await Promise.all([
        createDiscoveryJobByOps(deps, actor, { provider: "fixture", criteria: { prefecture: "愛知県" } }),
        updateCandidate(deps, actor, { companyId: company.id, patch: { name: "改ざん" } }),
        setOfficialSiteStatus(deps, actor, { companyId: company.id, status: "confirmed" }),
        excludeCandidate(deps, actor, { companyId: company.id, kind: "excluded", reason: "x" }),
        createImageAsset(deps, actor, {
          companyId: company.id,
          label: "外観",
          sourceType: "original_site",
          sourceUrl: "https://example.test/exterior.jpg",
        }),
        reviewProposalVersion(deps, actor, { proposalVersionId: version!.id, decision: "approved" }),
        makeSellable(deps, actor, { companyId: company.id, productTermsId: terms.id }),
        withdrawSellable(deps, actor, { companyId: company.id, reason: "x" }),
        releaseAssignmentByOps(deps, actor, { assignmentId: a!.id, reason: "x" }),
        reassignAssignmentByOps(deps, actor, { assignmentId: a!.id, toUserId: other.id, reason: "x" }),
        extendAssignmentByOps(deps, actor, { assignmentId: a!.id, expiresAt: new Date("2026-12-01") }),
        liftSuppressionByOps(deps, actor, { companyId: company.id, reason: "x" }),
        createProductTermsVersion(deps, actor, {
          version: "evil",
          name: "x",
          scopeText: "",
          price: 1,
          monthlyFee: null,
          rewardRule: TEST_RULE,
        }),
        setProductTermsActive(deps, actor, { productTermsId: terms.id, active: false }),
        updateSetting(deps, actor, { key: "assignment.maxActivePerUser", value: 99 }),
        suspendSalesUser(deps, actor, { userId: other.id }),
        recordPaymentByOps(deps, actor, { contractId: a!.id, amount: 1 }),
        adjustRewardByOps(deps, actor, { rewardId: a!.id, delta: 1, reason: "x" }),
        rejectContractByOps(deps, actor, { contractId: a!.id, reason: "x" }),
        confirmContractByOps(deps, actor, { contractId: a!.id }),
      ]);
      for (const r of results) {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe("forbidden");
      }
    }
    expect((await db.select().from(auditEvents)).length).toBe(before);
    const [c] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(c!.name).not.toBe("改ざん");
    expect(c!.pipelineStatus).not.toBe("sellable");
    expect(await getSetting(db, "assignment.maxActivePerUser")).toBe(3);
    expect(await db.select().from(discoveryJobs)).toHaveLength(0);
  });

  it("すべての運営の読み取りが forbidden を返す", async () => {
    const { actor: sales } = await seedUser(db, "sales");
    const { company } = await seedCandidate(db);
    for (const actor of [sales, null] as (Actor | null)[]) {
      const results = await Promise.all([
        getOpsDashboard(db, actor),
        listDiscoveryJobs(db, actor),
        listCompanies(db, actor),
        getCompanyDetail(db, actor, company.id),
        listReviewQueue(db, actor),
        listAssignmentsOverview(db, actor),
        listConsultations(db, actor),
        listContractsOverview(db, actor),
        listDomainPreferencesForOps(db, actor),
        getSettingsForOps(db, actor),
        listAuditEventsForOps(db, actor),
        listUsersForOps(db, actor),
      ]);
      for (const r of results) expect(r).toMatchObject({ ok: false, error: "forbidden" });
    }
  });

  it("アカウント管理の一覧は運営以外には絞り込み付きでも forbidden、運営には条件どおり返す", async () => {
    const { actor: ops } = await seedUser(db, "ops");
    const { actor: sales, user: salesUser } = await seedUser(db, "sales");
    const { user: stopped } = await seedUser(db, "sales");
    expect((await suspendSalesUser(deps, ops, { userId: stopped.id, reason: "テスト" })).ok).toBe(true);
    const outsiders: (Actor | null)[] = [
      sales,
      null,
      { kind: "customer_user", userId: salesUser.id },
      { kind: "customer", shareLinkId: salesUser.id },
      { kind: "system", job: "test" },
    ];
    for (const actor of outsiders)
      for (const filter of [{}, { role: "sales" as const }, { status: "suspended" as const }])
        expect(await listUsersForOps(db, actor, filter)).toMatchObject({ ok: false, error: "forbidden" });

    const all = await listUsersForOps(db, ops);
    const onlyStopped = await listUsersForOps(db, ops, { role: "sales", status: "suspended" });
    const onlyOps = await listUsersForOps(db, ops, { role: "ops" });
    if (!all.ok || !onlyStopped.ok || !onlyOps.ok) throw new Error("運営は一覧を読めるはず");
    expect(all.value.length).toBeGreaterThanOrEqual(3);
    expect(onlyStopped.value.map((u) => u.id)).toEqual([stopped.id]);
    expect(onlyOps.value.every((u) => u.role === "ops")).toBe(true);
    expect(onlyOps.value.map((u) => u.id)).toContain(ops.userId);
  });
});

describe("営業可能化（AC-09・14章）", () => {
  it("販売条件・報酬条件が未設定なら営業可能にできない", async () => {
    const { actor: ops } = await seedUser(db, "ops");
    const { company } = await seedCandidate(db, { versionStatus: "approved" });
    const noPrice = await seedTerms(db, { version: "no-price", price: null, rewardRule: TEST_RULE });
    const noRule = await seedTerms(db, { version: "no-rule", price: 300_000, rewardRule: null });
    const inactive = await seedTerms(db, { version: "inactive", price: 300_000, rewardRule: TEST_RULE, active: false });

    for (const t of [noPrice, noRule, inactive]) {
      const r = await makeSellable(deps, ops, { companyId: company.id, productTermsId: t.id });
      expect(r).toMatchObject({ ok: false, error: "terms_not_ready" });
    }
    expect(await makeSellable(deps, ops, { companyId: company.id, productTermsId: null })).toMatchObject({
      ok: false,
      error: "terms_not_selected",
    });
    const [c] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(c!.pipelineStatus).toBe("in_review");
    expect(await eventCount("company.make_sellable")).toBe(0);
  });

  it("レビュー未承認（運営確認待ち・差し戻し・版なし）なら営業可能にできない。承認後はできる", async () => {
    const { actor: ops } = await seedUser(db, "ops");
    const terms = await seedTerms(db, { version: "t-1", price: 300_000, rewardRule: TEST_RULE });

    const noVersion = await seedCandidate(db, { versionStatus: null });
    expect(await makeSellable(deps, ops, { companyId: noVersion.company.id, productTermsId: terms.id })).toMatchObject({
      ok: false,
      error: "no_proposal_version",
    });

    const pending = await seedCandidate(db, { versionStatus: "in_review" });
    expect(await makeSellable(deps, ops, { companyId: pending.company.id, productTermsId: terms.id })).toMatchObject({
      ok: false,
      error: "review_not_approved",
    });

    // 差し戻しは理由が必須
    expect(
      await reviewProposalVersion(deps, ops, { proposalVersionId: pending.version!.id, decision: "rejected" }),
    ).toMatchObject({ ok: false, error: "invalid_input" });

    // AIの事前チェックが無い版は承認できない
    expect(
      await reviewProposalVersion(deps, ops, { proposalVersionId: pending.version!.id, decision: "approved" }),
    ).toMatchObject({ ok: false, error: "ai_check_not_passed" });
    await db
      .update(proposalVersions)
      .set({ content: { aiCheck: testPrecheck() } })
      .where(eq(proposalVersions.id, pending.version!.id));
    const approved = await reviewProposalVersion(deps, ops, {
      proposalVersionId: pending.version!.id,
      decision: "approved",
      note: "事実確認済み",
    });
    expect(approved.ok).toBe(true);
    // 承認しただけでは営業可能にならない
    let [c] = await db.select().from(companies).where(eq(companies.id, pending.company.id));
    expect(c!.pipelineStatus).toBe("in_review");

    const r = await makeSellable(deps, ops, { companyId: pending.company.id, productTermsId: terms.id });
    expect(r.ok).toBe(true);
    [c] = await db.select().from(companies).where(eq(companies.id, pending.company.id));
    expect(c!.pipelineStatus).toBe("sellable");
    const [ev] = await db.select().from(auditEvents).where(eq(auditEvents.action, "company.make_sellable"));
    expect(ev!.after).toMatchObject({ productTermsId: terms.id, proposalVersionId: pending.version!.id });

    // 2回目は already_sellable
    expect(await makeSellable(deps, ops, { companyId: pending.company.id, productTermsId: terms.id })).toMatchObject({
      ok: false,
      error: "already_sellable",
    });
  });

  it("古い版が承認済みでも、最新の版が未確認なら営業可能にできない", async () => {
    const { actor: ops } = await seedUser(db, "ops");
    const terms = await seedTerms(db, { version: "t-1", price: 300_000, rewardRule: TEST_RULE });
    const { company, proposal } = await seedCandidate(db, { versionStatus: "approved" });
    await db.insert(proposalVersions).values({ proposalId: proposal.id, version: 2, status: "in_review" });
    expect(await makeSellable(deps, ops, { companyId: company.id, productTermsId: terms.id })).toMatchObject({
      ok: false,
      error: "review_not_approved",
    });
  });

  it("営業抑止（除外）がある候補は営業可能にできない。差し戻しで候補は保留になる", async () => {
    const { actor: ops } = await seedUser(db, "ops");
    const terms = await seedTerms(db, { version: "t-1", price: 300_000, rewardRule: TEST_RULE });
    const { company } = await seedCandidate(db, { versionStatus: "approved" });
    expect((await excludeCandidate(deps, ops, { companyId: company.id, kind: "excluded", reason: "対象外" })).ok).toBe(
      true,
    );
    expect(await makeSellable(deps, ops, { companyId: company.id, productTermsId: terms.id })).toMatchObject({
      ok: false,
      error: "company_suppressed",
    });

    const other = await seedCandidate(db, { versionStatus: "in_review" });
    const rej = await reviewProposalVersion(deps, ops, {
      proposalVersionId: other.version!.id,
      decision: "rejected",
      note: "実績の根拠が不明",
    });
    expect(rej.ok).toBe(true);
    const [c] = await db.select().from(companies).where(eq(companies.id, other.company.id));
    expect(c!.pipelineStatus).toBe("on_hold");
  });

  it("sellableIssues（画面表示と処理で共通の判定）", () => {
    const ready = { price: 1, rewardRule: TEST_RULE, active: true };
    const company = { suppression: "none", pipelineStatus: "in_review" };
    expect(sellableIssues({ company, latestVersion: { status: "approved" }, terms: ready })).toEqual([]);
    expect(sellableIssues({ company, latestVersion: { status: "in_review" }, terms: ready })).toEqual([
      "review_not_approved",
    ]);
    expect(
      sellableIssues({ company, latestVersion: { status: "approved" }, terms: { ...ready, rewardRule: null } }),
    ).toEqual(["terms_not_ready"]);
  });
});

describe("運営設定と操作履歴", () => {
  it("設定変更が操作履歴に残り、getSetting に反映される", async () => {
    const { actor: ops, user } = await seedUser(db, "ops");
    const r = await updateSetting(deps, ops, { key: "assignment.maxActivePerUser", value: 5 });
    expect(r.ok).toBe(true);
    expect(await getSetting(db, "assignment.maxActivePerUser")).toBe(5);
    await updateSetting(deps, ops, { key: "assignment.maxActivePerUser", value: 4 });

    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "settings.update"));
    expect(events).toHaveLength(2);
    expect(events.map((e) => [e.before, e.after, e.actorId, e.targetId])).toEqual(
      expect.arrayContaining([
        [{ value: 3, default: true }, { value: 5 }, user.id, "assignment.maxActivePerUser"],
        [{ value: 5, default: false }, { value: 4 }, user.id, "assignment.maxActivePerUser"],
      ]),
    );

    const log = await listAuditEventsForOps(db, ops, { targetType: "settings" });
    expect(log.ok && log.value.length).toBe(2);
    const settings = await getSettingsForOps(db, ops);
    expect(settings.ok && settings.value.find((s) => s.key === "assignment.maxActivePerUser")?.value).toBe(4);
  });

  it("範囲外・未知のキーは受け付けず、履歴も残さない", async () => {
    const { actor: ops } = await seedUser(db, "ops");
    for (const input of [
      { key: "assignment.maxActivePerUser", value: 0 },
      { key: "assignment.maxActivePerUser", value: 1.5 },
      { key: "unknown.key", value: 1 },
      { key: "__proto__", value: 1 },
    ]) {
      expect(await updateSetting(deps, ops, input)).toMatchObject({ ok: false, error: "invalid_input" });
    }
    expect(await eventCount("settings.update")).toBe(0);
  });
});

describe("候補・収集ジョブ", () => {
  it("収集ジョブを作成でき、不正な条件・取得元は拒否する", async () => {
    const { actor: ops } = await seedUser(db, "ops");
    const bad = await createDiscoveryJobByOps(deps, ops, { provider: "fixture", criteria: { city: "名古屋市" } });
    expect(bad).toMatchObject({ ok: false, error: "invalid_criteria" });
    expect(await createDiscoveryJobByOps(deps, ops, { provider: "evil", criteria: {} })).toMatchObject({
      ok: false,
      error: "invalid_provider",
    });
    await db
      .insert(workerRuntimes)
      .values({ id: crypto.randomUUID(), mode: "demo", providers: ["fixture"], heartbeatAt: clock.now() });
    const r = await createDiscoveryJobByOps(deps, ops, {
      provider: "fixture",
      criteria: { prefecture: "愛知県", city: "名古屋市", industry: "建設", limit: 10 },
    });
    expect(r.ok).toBe(true);
    const jobs = await listDiscoveryJobs(db, ops);
    expect(jobs.ok && jobs.value).toHaveLength(1);
    expect(jobs.ok && jobs.value[0]).toMatchObject({ status: "queued", maxResults: 10, provider: "fixture" });
    expect(await eventCount("discovery.job_created")).toBe(1);
  });

  it("公式サイトの確認・候補の修正が履歴に残り、詳細に診断の根拠が出る", async () => {
    const { actor: ops } = await seedUser(db, "ops");
    const { company, website } = await seedCandidate(db);
    const conf = await setOfficialSiteStatus(deps, ops, {
      companyId: company.id,
      status: "confirmed",
      websiteId: website.id,
    });
    expect(conf.ok && conf.value.officialSiteStatus).toBe("confirmed");
    const upd = await updateCandidate(deps, ops, {
      companyId: company.id,
      patch: { industry: "工務店", address: "  ", name: company.name },
    });
    expect(upd.ok && upd.value.industry).toBe("工務店");
    const [ev] = await db.select().from(auditEvents).where(eq(auditEvents.action, "company.update_by_ops"));
    expect(ev!.after).toEqual({ industry: "工務店" });

    const filtered = await listCompanies(db, ops, { officialSiteStatus: "needs_review" });
    expect(filtered.ok && filtered.value).toHaveLength(0);

    const detail = await getCompanyDetail(db, ops, company.id);
    expect(detail.ok).toBe(true);
    if (!detail.ok || !detail.value) throw new Error("detail");
    expect(detail.value.latestAudit?.totalScore).toBe("48.5");
    expect(detail.value.findings[0]).toMatchObject({ itemCode: "D1", critical: true });
    expect(detail.value.websites[0]!.isPrimary).toBe(true);
  });
});

describe("画像素材の権利と利用範囲", () => {
  it("登録時は評価参照のみに固定し、権利未確認のままデモ・本番利用を許可できない", async () => {
    const { actor: ops } = await seedUser(db, "ops");
    const { company } = await seedCandidate(db);
    const created = await createImageAsset(deps, ops, {
      companyId: company.id,
      label: "トップページの店舗外観",
      sourceType: "original_site",
      sourceUrl: "https://example.test/exterior.jpg",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    expect(created.value).toMatchObject({
      rightsStatus: "unknown",
      allowSalesDemo: false,
      allowProduction: false,
      confirmedBy: null,
      confirmedAt: null,
    });

    expect(
      await updateImageAssetPolicy(deps, ops, {
        companyId: company.id,
        imageAssetId: created.value.id,
        rightsStatus: "unknown",
        allowSalesDemo: true,
        allowProduction: false,
      }),
    ).toMatchObject({ ok: false, error: "rights_unconfirmed" });
    expect(await eventCount("image_asset.policy_update")).toBe(0);
  });

  it("許諾確認後は用途と確認者・日時を記録し、企業詳細に表示する", async () => {
    const { actor: ops, user } = await seedUser(db, "ops");
    const { company } = await seedCandidate(db);
    const created = await createImageAsset(deps, ops, {
      companyId: company.id,
      label: "ロゴ",
      sourceType: "customer_upload",
      note: "顧客から提供",
    });
    if (!created.ok) throw new Error(created.error);
    const updated = await updateImageAssetPolicy(deps, ops, {
      companyId: company.id,
      imageAssetId: created.value.id,
      rightsStatus: "use_approved",
      allowSalesDemo: true,
      allowProduction: true,
      note: "デモ・納品利用の許諾を確認",
    });
    expect(updated.ok && updated.value).toMatchObject({
      rightsStatus: "use_approved",
      allowSalesDemo: true,
      allowProduction: true,
      confirmedBy: user.id,
      confirmedAt: clock.now(),
    });
    expect(await eventCount("image_asset.create")).toBe(1);
    expect(await eventCount("image_asset.policy_update")).toBe(1);

    const detail = await getCompanyDetail(db, ops, company.id);
    expect(detail.ok && detail.value?.imageAssets[0]).toMatchObject({
      confirmerName: user.displayName,
      asset: { id: created.value.id, allowProduction: true },
    });
    expect(await db.select().from(imageAssets)).toHaveLength(1);
  });
});

describe("担当・契約は core の業務関数を経由する", () => {
  it("運営確認待ちの担当を延長し、付け替えができる。営業抑止は運営が解除できる", async () => {
    const { actor: ops } = await seedUser(db, "ops");
    const { user: s1 } = await seedUser(db, "sales");
    const { user: s2 } = await seedUser(db, "sales");
    const { company } = await seedCandidate(db, { versionStatus: "approved" });
    const [a] = await db
      .insert(assignments)
      .values({ companyId: company.id, userId: s1.id, status: "awaiting_ops", claimedAt: clock.now() })
      .returning();
    const ext = await extendAssignmentByOps(deps, ops, {
      assignmentId: a!.id,
      expiresAt: new Date("2026-10-20T00:00:00Z"),
    });
    expect(ext.ok && ext.value.status).toBe("negotiating");
    const re = await reassignAssignmentByOps(deps, ops, { assignmentId: a!.id, toUserId: s2.id, reason: "引き継ぎ" });
    expect(re.ok).toBe(true);
    const overview = await listAssignmentsOverview(db, ops);
    expect(overview.ok && overview.value.map((r) => r.a.userId)).toEqual([s2.id]);

    await db.update(companies).set({ suppression: "not_now" }).where(eq(companies.id, company.id));
    expect((await liftSuppressionByOps(deps, ops, { companyId: company.id, reason: "企業から再連絡の希望" })).ok).toBe(
      true,
    );
  });

  it("契約確認を再実行しても報酬は1件。差し戻し済みの契約は確認できない", async () => {
    const { actor: ops } = await seedUser(db, "ops");
    const { user: s1 } = await seedUser(db, "sales");
    const terms = await seedTerms(db, { version: "t-1", price: 300_000, rewardRule: TEST_RULE });
    const { company } = await seedCandidate(db, { versionStatus: "approved" });
    const [a] = await db
      .insert(assignments)
      .values({ companyId: company.id, userId: s1.id, status: "contract_pending", claimedAt: clock.now() })
      .returning();
    const [c] = await db
      .insert(contracts)
      .values({
        companyId: company.id,
        assignmentId: a!.id,
        salesUserId: s1.id,
        productTermsId: terms.id,
        documentRef: "doc-1",
        reportedAt: clock.now(),
      })
      .returning();
    expect((await confirmContractByOps(deps, ops, { contractId: c!.id })).ok).toBe(true);
    const again = await confirmContractByOps(deps, ops, { contractId: c!.id });
    expect(again.ok && again.value.alreadyCompleted).toBe(true);
    expect(await db.select().from(rewards)).toHaveLength(1);
    expect(await rejectContractByOps(deps, ops, { contractId: c!.id, reason: "x" })).toMatchObject({
      ok: false,
      error: "invalid_state",
    });
    const list = await listContractsOverview(db, ops);
    expect(list.ok && list.value[0]!.reward?.currentAmount).toBe(10_000);
  });
});
