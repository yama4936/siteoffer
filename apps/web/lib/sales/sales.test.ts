// 営業画面の読み取りクエリとサーバー処理の結合テスト（PGlite）。
// 金額・報酬条件はテスト内だけの値で、仕様の値ではない。
import {
  type Actor,
  adjustReward,
  claimAssignment,
  confirmContract,
  fixedClock,
  getSalesOffer,
  HOUR,
  saveCompanyProfile,
  scheduleRewardPayment,
} from "@siteoffer/core";
import {
  companies,
  type Db,
  findings,
  productTerms,
  proposals,
  proposalVersions,
  salesOffers,
  siteAudits,
  users,
  websites,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { EMPTY_COMPANY_PROFILE } from "@siteoffer/schemas";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimCompany,
  parseJstDateTime,
  recordSalesActivity,
  releaseMyAssignment,
  reportDeal,
  saveDomainWish,
} from "./operations.ts";
import {
  getCompanyDetail,
  getMyAssignmentDetail,
  getMyEarnings,
  listMyAssignments,
  listSellableCompanies,
} from "./queries.ts";

let db: Db;
let close: () => Promise<void>;
let clock: ReturnType<typeof fixedClock>;
let seq = 0;

it("運営が一度確認した連絡先を営業詳細と担当へ共通表示し、取り下げ後に旧候補を復活させない", async () => {
  const me = await user("sales"),
    ops = await user("ops"),
    other = await user("sales");
  const c = await company({ representativePhone: "052-000-1111" }),
    a = await claim(me.actor, c.id);
  const initial = await getCompanyDetail(db, me.actor, c.id);
  if (!initial.ok) throw Error(initial.error);
  expect(initial.value.company.contactVerified).toBe(false);
  await saveCompanyProfile(db, clock, ops.actor, {
    companyId: c.id,
    expectedRevision: 0,
    values: { ...EMPTY_COMPANY_PROFILE, phone: "052-123-4567", email: "contact@example.test" },
    source: "営業へは渡さない内部の確認資料名",
    confirmed: true,
  });
  const detail = await getCompanyDetail(db, me.actor, c.id),
    assignment = await getMyAssignmentDetail(db, me.actor, a.id);
  if (!detail.ok || !assignment.ok) throw Error("fixture read failed");
  for (const result of [detail.value, assignment.value]) {
    expect(result.company).toMatchObject({
      representativePhone: "052-123-4567",
      contactEmail: "contact@example.test",
      contactVerified: true,
    });
    expect(JSON.stringify(result)).not.toContain("営業へは渡さない内部の確認資料名");
  }
  expect((await getMyAssignmentDetail(db, other.actor, a.id)).ok).toBe(false);
  await saveCompanyProfile(db, clock, ops.actor, {
    companyId: c.id,
    expectedRevision: 1,
    values: EMPTY_COMPANY_PROFILE,
    source: "架空の使用取り下げ",
    confirmed: true,
  });
  const withdrawn = await getCompanyDetail(db, me.actor, c.id);
  if (!withdrawn.ok) throw Error(withdrawn.error);
  expect(withdrawn.value.company.representativePhone).toBeNull();
  expect(withdrawn.value.company.contactEmail).toBeNull();
});

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = fixedClock("2026-10-14T00:00:00Z");
});
afterEach(async () => {
  await close();
});

async function user(role: "sales" | "ops") {
  seq++;
  const [u] = await db
    .insert(users)
    .values({ email: `${role}${seq}@example.test`, passwordHash: "x", displayName: `${role}${seq}`, role })
    .returning();
  return { id: u!.id, actor: { kind: role, userId: u!.id } as Actor };
}

async function company(values: Partial<typeof companies.$inferInsert> = {}) {
  seq++;
  const [c] = await db
    .insert(companies)
    .values({ name: `架空工務店${seq}`, pipelineStatus: "sellable", prefecture: "愛知県", city: "名古屋市", ...values })
    .returning();
  if (c!.pipelineStatus === "sellable") {
    const existing = await db.select().from(productTerms);
    const t =
      existing.find((t) => t.price !== null && t.rewardRule !== null) ??
      (await terms({ price: 300000, rewardRule: { type: "fixed", amount: 30000 } }));
    const [p] = await db.insert(proposals).values({ companyId: c!.id }).returning();
    const [v] = await db
      .insert(proposalVersions)
      .values({ proposalId: p!.id, version: 1, status: "approved" })
      .returning();
    await db
      .insert(salesOffers)
      .values({ companyId: c!.id, version: 1, productTermsId: t.id, proposalVersionId: v!.id });
  }
  return c!;
}

async function terms(values: { price: number | null; rewardRule: unknown }) {
  seq++;
  const [t] = await db
    .insert(productTerms)
    .values({ version: `test-${seq}`, name: `テスト条件${seq}`, scope: { pages: ["top"] }, ...values })
    .returning();
  return t!;
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function claim(actor: Actor, companyId: string) {
  const r = await claimAssignment(db, clock, actor, companyId);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe("企業一覧", () => {
  it("営業可能な企業だけを返し、営業可能でない企業は出さない", async () => {
    const me = await user("sales");
    const sellable = await company();
    await company({ pipelineStatus: "audited" });
    await company({ pipelineStatus: "on_hold" });
    await company({ pipelineStatus: "in_review" });
    const r = await listSellableCompanies(db, me.actor);
    expect(r.ok && r.value.items.map((c) => c.id)).toEqual([sellable.id]);
  });

  it("都道府県・市区町村・業種で絞り込める", async () => {
    const me = await user("sales");
    const a = await company({ prefecture: "愛知県", city: "名古屋市", industry: "工務店" });
    const b = await company({ prefecture: "愛知県", city: "豊橋市", industry: "工務店" });
    const c = await company({ prefecture: "岐阜県", city: "岐阜市", industry: "歯科" });
    const ids = async (f: Parameters<typeof listSellableCompanies>[2]) => {
      const r = await listSellableCompanies(db, me.actor, f);
      if (!r.ok) throw new Error(r.error);
      return r.value.items.map((x) => x.id).sort();
    };
    expect(await ids({ prefecture: "愛知県" })).toEqual([a.id, b.id].sort());
    expect(await ids({ prefecture: "愛知県", city: "豊橋市" })).toEqual([b.id]);
    expect(await ids({ industry: "歯科" })).toEqual([c.id]);
    expect(await ids({ prefecture: " " })).toHaveLength(3);
    const directory = await listSellableCompanies(db, me.actor);
    if (!directory.ok) throw new Error(directory.error);
    const opts = directory.value.options;
    expect(opts.prefectures).toEqual(expect.arrayContaining(["愛知県", "岐阜県"]));
    expect(opts.industries).toEqual(expect.arrayContaining(["工務店", "歯科"]));
  });

  it("担当中・営業拒否の共通状態を出すが、他人の担当者は返さない", async () => {
    const me = await user("sales");
    const other = await user("sales");
    const mine = await company();
    const others = await company();
    const refused = await company({ suppression: "do_not_contact" });
    const myA = await claim(me.actor, mine.id);
    await claim(other.actor, others.id);
    const r = await listSellableCompanies(db, me.actor);
    if (!r.ok) throw new Error(r.error);
    const byId = new Map(r.value.items.map((c) => [c.id, c]));
    expect(byId.get(mine.id)).toMatchObject({ assignment: "mine", myAssignmentId: myA.id });
    expect(byId.get(others.id)).toMatchObject({ assignment: "other", myAssignmentId: null });
    expect(byId.get(refused.id)).toMatchObject({ assignment: "none", suppression: "do_not_contact" });
    expect(JSON.stringify(r.value.items)).not.toContain(other.id);
  });

  it("最新の評価の総合点で並べ替え、点数のない企業は末尾に置く", async () => {
    const me = await user("sales");
    const audit = async (companyId: string, totalScore: string | null, createdAt: string, status = "evaluated") => {
      const [site] = await db
        .insert(websites)
        .values({
          companyId,
          url: `https://${createdAt.slice(0, 10)}.${companyId}.example.test/`,
          normalizedUrl: `https://${createdAt.slice(0, 10)}.${companyId}.example.test/`,
          domain: "example.test",
          isPrimary: true,
        })
        .returning();
      await db.insert(siteAudits).values({
        companyId,
        websiteId: site!.id,
        status: status as "evaluated",
        targetUrl: "https://example.test/",
        totalScore,
        createdAt: new Date(createdAt),
      });
    };
    const high = await company({ name: "あ" });
    const low = await company({ name: "い" });
    const rescored = await company({ name: "う" });
    const unevaluable = await company({ name: "え" });
    const none = await company({ name: "お" });
    await audit(high.id, "80", "2026-10-01T00:00:00Z");
    await audit(low.id, "30.5", "2026-10-01T00:00:00Z");
    // 古い評価は低いが、最新は55点
    await audit(rescored.id, "10", "2026-09-01T00:00:00Z");
    await audit(rescored.id, "55", "2026-10-01T00:00:00Z");
    await audit(unevaluable.id, null, "2026-10-01T00:00:00Z", "unevaluable");
    // 評価中（queued）は数えない
    await audit(none.id, "5", "2026-10-02T00:00:00Z", "queued");

    const ids = async (sort: "region" | "score_asc" | "score_desc") => {
      const r = await listSellableCompanies(db, me.actor, { sort });
      if (!r.ok) throw new Error(r.error);
      return r.value.items.map((x) => x.id);
    };
    expect(await ids("score_asc")).toEqual([low.id, rescored.id, high.id, unevaluable.id, none.id]);
    expect(await ids("score_desc")).toEqual([high.id, rescored.id, low.id, unevaluable.id, none.id]);
    expect(await ids("region")).toEqual([high.id, low.id, rescored.id, unevaluable.id, none.id]);
    // 指定なしは評価点の低い順
    const def = await listSellableCompanies(db, me.actor, {});
    expect(def.ok && def.value.items.map((x) => x.id)).toEqual(await ids("score_asc"));
    const r = await listSellableCompanies(db, me.actor, { sort: "score_asc" });
    expect(r.ok && r.value.items[1]).toMatchObject({ totalScore: "55" });
    expect(r.ok && r.value.items[4]).toMatchObject({ totalScore: null });
  });

  it("未ログインは拒否する", async () => {
    await company();
    const r = await listSellableCompanies(db, null);
    expect(r.ok).toBe(false);
  });
});

describe("企業詳細", () => {
  it("営業可能でない企業は見られない（存在も明かさない）", async () => {
    const me = await user("sales");
    const c = await company({ pipelineStatus: "generated" });
    const r = await getCompanyDetail(db, me.actor, c.id);
    expect(r).toMatchObject({ ok: false, error: "not_found" });
  });

  it("営業可能でなくなっても自分の担当企業は見られる", async () => {
    const me = await user("sales");
    const c = await company();
    await claim(me.actor, c.id);
    await db.update(companies).set({ pipelineStatus: "on_hold" }).where(eq(companies.id, c.id));
    const r = await getCompanyDetail(db, me.actor, c.id);
    expect(r.ok && r.value.assignment).toBe("mine");
  });

  it("診断根拠（観測と推測の区別）、承認済みの提案、販売条件を返す", async () => {
    const me = await user("sales");
    const c = await company({ representativePhone: "052-000-0000" });
    const [site] = await db
      .insert(websites)
      .values({
        companyId: c.id,
        url: "https://example.test/",
        normalizedUrl: "example.test/",
        domain: "example.test",
        isPrimary: true,
      })
      .returning();
    const [audit] = await db
      .insert(siteAudits)
      .values({
        companyId: c.id,
        websiteId: site!.id,
        status: "evaluated",
        targetUrl: "https://example.test/",
        totalScore: "42.5",
      })
      .returning();
    await db.insert(findings).values([
      {
        auditId: audit!.id,
        itemCode: "A1",
        category: "A",
        status: "scored",
        score: 1,
        reason: "電話番号がファーストビューにない",
        observations: [{ fact: "トップに電話番号の表示がない", url: "https://example.test/", evidence: "ヘッダー" }],
        inference: false,
      },
      {
        auditId: audit!.id,
        itemCode: "B2",
        category: "B",
        status: "scored",
        score: 2,
        reason: "更新が止まっている可能性",
        observations: [{ fact: "お知らせの最新が2019年", url: null, evidence: "お知らせ欄" }],
        inference: true,
      },
    ]);
    const [proposal] = await db.select().from(proposals).where(eq(proposals.companyId, c.id));
    const callScript = {
      opening: "非公式の改善提案のご案内です",
      sections: [{ title: "用件", lines: ["ホームページについてご提案があります"] }],
      onDecline: "承知しました。今後のご連絡について伺えますか",
      closing: "ありがとうございました",
      doNotSay: ["必ず売上が上がる"],
    };
    await db
      .update(proposalVersions)
      .set({ content: { callScript }, demoArtifactDir: "/tmp/x" })
      .where(eq(proposalVersions.proposalId, proposal!.id));
    await db
      .insert(proposalVersions)
      .values({ proposalId: proposal!.id, version: 2, status: "in_review", content: { callScript } });
    await terms({ price: 300000, rewardRule: { type: "fixed", amount: 30000 } });
    await terms({ price: null, rewardRule: null });

    const r = await getCompanyDetail(db, me.actor, c.id);
    if (!r.ok) throw new Error(r.error);
    const d = r.value;
    expect(d.showClaim).toBe(true);
    expect(d.company.representativePhone).toBe("052-000-0000");
    expect(d.sites.map((s) => s.url)).toEqual(["https://example.test/"]);
    expect(d.audit?.findings.map((f) => [f.itemCode, f.inference])).toEqual([
      ["A1", false],
      ["B2", true],
    ]);
    expect(d.audit?.findings[0]?.observations[0]?.fact).toBe("トップに電話番号の表示がない");
    // 承認済み（approved）の最新版だけ
    expect(d.proposal?.version).toBe(1);
    expect(d.proposal?.callScript?.opening).toBe(callScript.opening);
    // 版IDから組み立てた固定のURLは返さない（企業に見せるURLは共有リンクで発行する）
    expect(d.proposal?.hasDemo).toBe(true);
    expect(JSON.stringify(d.proposal)).not.toContain("/demo/");
    expect(d.terms.map((t) => t.ready)).toEqual([true]);
  });

  it("他人の担当企業は担当中とだけ表示し、確保ボタンを出さない", async () => {
    const me = await user("sales");
    const other = await user("sales");
    const c = await company();
    await claim(other.actor, c.id);
    const r = await getCompanyDetail(db, me.actor, c.id);
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toMatchObject({ assignment: "other", myAssignmentId: null, showClaim: false });
    expect(JSON.stringify(r.value)).not.toContain(other.id);
  });
});

describe("担当案件", () => {
  it("自分の担当だけを返し、他人の担当の詳細は見られない", async () => {
    const me = await user("sales");
    const other = await user("sales");
    const c1 = await company();
    const c2 = await company();
    const mine = await claim(me.actor, c1.id);
    const theirs = await claim(other.actor, c2.id);
    await recordSalesActivity(
      { db, clock, actor: other.actor },
      form({ assignmentId: theirs.id, kind: "no_answer", note: "他人の詳細メモ" }),
    );

    const list = await listMyAssignments(db, me.actor);
    expect(list.ok && list.value.map((a) => a.id)).toEqual([mine.id]);

    const detail = await getMyAssignmentDetail(db, me.actor, theirs.id);
    expect(detail).toMatchObject({ ok: false, error: "not_found" });

    const own = await getMyAssignmentDetail(db, me.actor, mine.id);
    expect(own.ok && own.value.company.id).toBe(c1.id);
    expect(JSON.stringify(own)).not.toContain("他人の詳細メモ");
  });

  it("終了した担当は既定では出さず、includeEnded で出す", async () => {
    const me = await user("sales");
    const c = await company();
    const a = await claim(me.actor, c.id);
    const rel = await releaseMyAssignment({ db, clock, actor: me.actor }, form({ assignmentId: a.id }));
    expect(rel?.status).toBe("ok");
    const active = await listMyAssignments(db, me.actor);
    expect(active.ok && active.value).toEqual([]);
    const all = await listMyAssignments(db, me.actor, { includeEnded: true });
    expect(all.ok && all.value.map((x) => x.status)).toEqual(["released"]);
  });
});

describe("サーバー処理", () => {
  it("担当確保：成功、他人が担当中なら already_assigned、営業可能でなければ拒否", async () => {
    const me = await user("sales");
    const other = await user("sales");
    const c = await company();
    const r1 = await claimCompany(
      { db, clock, actor: me.actor },
      form({ companyId: c.id, salesOfferId: (await getSalesOffer(db, c.id))!.offer.id }),
    );
    expect(r1).toMatchObject({ status: "ok" });
    expect(r1?.assignmentId).toBeTruthy();
    const r2 = await claimCompany({ db, clock, actor: other.actor }, form({ companyId: c.id }));
    expect(r2?.status).toBe("error");
    expect(r2?.message).toContain("担当中");
    const hidden = await company({ pipelineStatus: "audited" });
    const r3 = await claimCompany({ db, clock, actor: me.actor }, form({ companyId: hidden.id }));
    expect(r3?.status).toBe("error");
    const r4 = await claimCompany({ db, clock, actor: null }, form({ companyId: c.id }));
    expect(r4?.status).toBe("error");
  });

  it("活動記録：次回対応日を日本時間で読み、他人の担当には記録できない", async () => {
    const me = await user("sales");
    const other = await user("sales");
    const c = await company();
    const a = await claim(me.actor, c.id);
    const ok = await recordSalesActivity(
      { db, clock, actor: me.actor },
      form({ assignmentId: a.id, kind: "callback_scheduled", nextActionAt: "2026-10-20T10:00", consultOps: "on" }),
    );
    expect(ok?.status).toBe("ok");
    const detail = await getMyAssignmentDetail(db, me.actor, a.id);
    if (!detail.ok) throw new Error(detail.error);
    expect(detail.value.activities[0]).toMatchObject({ kind: "callback_scheduled", consultOps: true });
    expect(detail.value.assignment.nextActionAt?.toISOString()).toBe("2026-10-20T01:00:00.000Z");

    const ng = await recordSalesActivity(
      { db, clock, actor: other.actor },
      form({ assignmentId: a.id, kind: "no_answer" }),
    );
    expect(ng?.status).toBe("error");
    // 再連絡予定には次回対応日が必要（core の判定）
    const missing = await recordSalesActivity(
      { db, clock, actor: me.actor },
      form({ assignmentId: a.id, kind: "callback_scheduled" }),
    );
    expect(missing?.status).toBe("error");
  });

  it("営業拒否は企業共通の状態になり、一覧に表示される", async () => {
    const me = await user("sales");
    const other = await user("sales");
    const c = await company();
    const a = await claim(me.actor, c.id);
    const r = await recordSalesActivity(
      { db, clock, actor: me.actor },
      form({ assignmentId: a.id, kind: "declined", declineKind: "not_now", recontactAfter: "2027-04-01" }),
    );
    expect(r?.status).toBe("ok");
    const list = await listSellableCompanies(db, other.actor);
    expect(list.ok && list.value.items.find((x) => x.id === c.id)).toMatchObject({
      suppression: "not_now",
      assignment: "none",
    });
    const detail = await getCompanyDetail(db, other.actor, c.id);
    expect(detail.ok && detail.value.showClaim).toBe(false);
    const noKind = await recordSalesActivity(
      { db, clock, actor: me.actor },
      form({ assignmentId: a.id, kind: "declined" }),
    );
    expect(noKind?.status).toBe("error");
  });

  it("ドメイン希望：注意文を返し、秘密らしき値は保存しない", async () => {
    const me = await user("sales");
    const other = await user("sales");
    const c = await company();
    const a = await claim(me.actor, c.id);
    const saved = await saveDomainWish(
      { db, clock, actor: me.actor },
      form({
        assignmentId: a.id,
        companyId: c.id,
        intent: "new",
        newDomainCandidates: "kakuu-koumuten.jp\nkakuu.example",
        currentManager: "vendor",
        usesEmail: "yes",
      }),
    );
    expect(saved?.status).toBe("ok");
    expect(saved?.notices?.join("")).toContain("保証するものではありません");

    const secret = await saveDomainWish(
      { db, clock, actor: me.actor },
      form({ assignmentId: a.id, companyId: c.id, intent: "transfer_consult", customerWish: "移管コード: Abc123XyZ!" }),
    );
    expect(secret?.status).toBe("error");
    expect(secret?.message).not.toContain("Abc123XyZ");

    const others = await saveDomainWish(
      { db, clock, actor: other.actor },
      form({ assignmentId: a.id, companyId: c.id, intent: "keep" }),
    );
    expect(others?.status).toBe("error");

    const detail = await getMyAssignmentDetail(db, me.actor, a.id);
    expect(detail.ok && detail.value.domainPreference).toMatchObject({
      intent: "new",
      newDomainCandidates: ["kakuu-koumuten.jp", "kakuu.example"],
      needsOpsReview: true,
    });
  });

  it("成約報告：報告後は契約確認待ちになり、二重報告と他人の報告はできない", async () => {
    const me = await user("sales");
    const other = await user("sales");
    const c = await company();
    const a = await claim(me.actor, c.id);
    const t = (await getSalesOffer(db, c.id, a.salesOfferId))!.terms;

    const ng = await reportDeal({ db, clock, actor: other.actor }, form({ assignmentId: a.id }));
    expect(ng?.status).toBe("error");

    const r = await reportDeal(
      { db, clock, actor: me.actor },
      form({ assignmentId: a.id, productTermsId: t.id, documentRef: "契約書_架空工務店.pdf" }),
    );
    expect(r?.status).toBe("ok");
    const again = await reportDeal({ db, clock, actor: me.actor }, form({ assignmentId: a.id }));
    expect(again?.status).toBe("error");

    const detail = await getMyAssignmentDetail(db, me.actor, a.id);
    if (!detail.ok) throw new Error(detail.error);
    expect(detail.value.assignment.status).toBe("contract_pending");
    expect(detail.value.contracts.map((x) => x.status)).toEqual(["reported"]);
    expect(detail.value.showReport).toBe(false);
  });
});

describe("実績・報酬", () => {
  it("自分の契約と報酬だけを集計し、他人のものは含めない", async () => {
    const me = await user("sales");
    const other = await user("sales");
    const ops = await user("ops");
    const t = await terms({ price: 300000, rewardRule: { type: "fixed", amount: 30000 } });

    async function completedDeal(actor: Actor) {
      const c = await company();
      const a = await claim(actor, c.id);
      const r = await reportDeal(
        { db, clock, actor },
        form({ assignmentId: a.id, productTermsId: t.id, documentRef: "doc.pdf" }),
      );
      if (r?.status !== "ok") throw new Error(r?.message);
      const detail = await getMyAssignmentDetail(db, actor, a.id);
      if (!detail.ok) throw new Error(detail.error);
      const confirmed = await confirmContract(db, clock, ops.actor, { contractId: detail.value.contracts[0]!.id });
      if (!confirmed.ok) throw new Error(confirmed.error);
      return confirmed.value.reward;
    }

    const r1 = await completedDeal(me.actor);
    const r2 = await completedDeal(me.actor);
    await completedDeal(other.actor);
    // 報告だけの契約（未完了）
    const pendingCompany = await company();
    const pa = await claim(me.actor, pendingCompany.id);
    await reportDeal({ db, clock, actor: me.actor }, form({ assignmentId: pa.id }));

    clock.advance(HOUR);
    const s = await scheduleRewardPayment(db, clock, ops.actor, {
      rewardId: r1.id,
      scheduledFor: new Date("2026-11-30T00:00:00Z"),
    });
    expect(s.ok).toBe(true);
    const adj = await adjustReward(db, clock, ops.actor, { rewardId: r2.id, delta: -5000, reason: "テストの調整" });
    expect(adj.ok).toBe(true);

    const e = await getMyEarnings(db, me.actor);
    if (!e.ok) throw new Error(e.error);
    expect(e.value.contracts).toHaveLength(3);
    expect(e.value.totals).toEqual({ completedContracts: 2, accrued: 55000, scheduled: 30000, paid: 0 });
    expect(e.value.rewards.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
    expect(e.value.rewards.find((r) => r.id === r2.id)).toMatchObject({ currentAmount: 25000, adjusted: true });

    const theirs = await getMyEarnings(db, other.actor);
    expect(theirs.ok && theirs.value.rewards).toHaveLength(1);
    expect(theirs.ok && theirs.value.totals.accrued).toBe(30000);
  });
});

describe("日時の読み取り", () => {
  it("datetime-local と date を日本時間として読む", () => {
    expect(parseJstDateTime("2026-10-20T10:00")?.toISOString()).toBe("2026-10-20T01:00:00.000Z");
    expect(parseJstDateTime("2026-10-20")?.toISOString()).toBe("2026-10-19T15:00:00.000Z");
    expect(parseJstDateTime("")).toBeUndefined();
    expect(parseJstDateTime("10/20")).toBeNull();
  });
});
