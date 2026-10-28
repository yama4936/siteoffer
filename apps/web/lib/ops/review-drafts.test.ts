import { randomUUID } from "node:crypto";
import { fixedClock } from "@siteoffer/core";
import {
  auditEvents,
  companies,
  type Db,
  productTerms,
  proposalReviewDrafts,
  proposalReviewSubmissions,
  proposals,
  proposalVersions,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EMPTY_REVIEW } from "./review-draft-types";
import { commitReviewDraft, loadReviewDraft, ReviewDraftConflict, saveReviewDraft } from "./review-drafts";
import { seedTerms, seedUser, testPrecheck } from "./test-seed";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
const complete = { note: "  引き継ぎ事項\n続き  " };
const TEST_RULE = { type: "fixed", amount: 10_000 };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
async function setup(aiCheck: unknown = testPrecheck()) {
  const { actor, user } = await seedUser(db, "ops");
  const [c] = await db
    .insert(companies)
    .values({ name: "架空・レビュー下書き", pipelineStatus: "in_review" })
    .returning();
  const [p] = await db.insert(proposals).values({ companyId: c!.id }).returning();
  const [v] = await db
    .insert(proposalVersions)
    .values({ proposalId: p!.id, version: 1, status: "in_review", content: aiCheck === null ? {} : { aiCheck } })
    .returning();
  return { actor, user, c: c!, p: p!, v: v! };
}
it("途中のメモをそのまま復元し、担当者・企業・版を分離する", async () => {
  const s = await setup();
  const values = { ...EMPTY_REVIEW, note: "  入力途中\n続き  " };
  expect(await saveReviewDraft(db, clock, s.actor, s.v.id, 0, values)).toMatchObject({ revision: 1, values });
  expect(await loadReviewDraft(db, s.actor, s.v.id)).toMatchObject({ revision: 1, values });
  const other = await seedUser(db, "ops");
  expect((await loadReviewDraft(db, other.actor, s.v.id)).values).toBeNull();
  const [v] = await db
    .insert(proposalVersions)
    .values({ proposalId: s.p.id, version: 2, status: "in_review" })
    .returning();
  expect((await loadReviewDraft(db, s.actor, v!.id)).values).toBeNull();
  const second = await setup();
  expect((await loadReviewDraft(db, s.actor, second.v.id)).values).toBeNull();
  expect(await db.select().from(auditEvents)).toHaveLength(0);
  expect((await db.select().from(proposalVersions).where(eq(proposalVersions.id, s.v.id)))[0]!.status).toBe(
    "in_review",
  );
});
it("古いタブの上書き・破棄を拒否し、破棄後も版を残して遅い保存で復活させない", async () => {
  const s = await setup();
  await saveReviewDraft(db, clock, s.actor, s.v.id, 0, complete);
  for (const value of [EMPTY_REVIEW, null])
    await expect(saveReviewDraft(db, clock, s.actor, s.v.id, 0, value)).rejects.toBeInstanceOf(ReviewDraftConflict);
  expect(await saveReviewDraft(db, clock, s.actor, s.v.id, 1, null)).toMatchObject({ revision: 2, values: null });
  await expect(saveReviewDraft(db, clock, s.actor, s.v.id, 1, complete)).rejects.toMatchObject({
    snapshot: { revision: 2, values: null },
  });
});
it.each(["approved", "rejected"] as const)(
  "%sの確定・下書き消込・受付を同時保存し、再送で二重記録しない",
  async (decision) => {
    const s = await setup();
    const other = await seedUser(db, "ops");
    await saveReviewDraft(db, clock, other.actor, s.v.id, 0, { ...EMPTY_REVIEW, note: "別担当の非公開メモ" });
    await saveReviewDraft(db, clock, s.actor, s.v.id, 0, complete);
    const input = { revision: 1, decision, requestKey: randomUUID() };
    const first = await commitReviewDraft(db, clock, s.actor, s.v.id, input);
    expect(first.snapshot).toMatchObject({ revision: 2, values: null });
    expect((await commitReviewDraft(db, clock, s.actor, s.v.id, input)).snapshot).toEqual(first.snapshot);
    expect(
      (await commitReviewDraft(db, clock, s.actor, s.v.id, { ...input, requestKey: input.requestKey.toUpperCase() }))
        .snapshot,
    ).toEqual(first.snapshot);
    expect(await db.select().from(proposalReviewSubmissions)).toHaveLength(1);
    const events = await db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe(decision === "approved" ? "proposal_version.approve" : "proposal_version.reject");
    if (decision === "approved")
      expect(events[0]!.after).toMatchObject({
        aiCheck: { status: "passed", checkPy: "c".repeat(64), items: [{ key: "company", ok: true }, {}, {}, {}] },
      });
    expect(first.sellable).toEqual(
      decision === "approved" ? { ok: false, reason: expect.stringContaining("販売条件") } : undefined,
    );
    expect(JSON.stringify(events)).not.toContain("別担当の非公開メモ");
    expect((await loadReviewDraft(db, other.actor, s.v.id)).values?.note).toBe("別担当の非公開メモ");
    expect((await db.select().from(proposalVersions).where(eq(proposalVersions.id, s.v.id)))[0]!.status).toBe(decision);
  },
);
it("確定済み版への保存・別操作での再承認を拒否する", async () => {
  const s = await setup();
  await saveReviewDraft(db, clock, s.actor, s.v.id, 0, complete);
  await commitReviewDraft(db, clock, s.actor, s.v.id, { revision: 1, decision: "approved", requestKey: randomUUID() });
  await expect(saveReviewDraft(db, clock, s.actor, s.v.id, 1, complete)).rejects.toBeInstanceOf(ReviewDraftConflict);
  await expect(saveReviewDraft(db, clock, s.actor, s.v.id, 2, complete)).rejects.toThrow("確認待ち");
  await expect(
    commitReviewDraft(db, clock, s.actor, s.v.id, { revision: 2, decision: "rejected", requestKey: randomUUID() }),
  ).rejects.toThrow();
  expect(await db.select().from(auditEvents)).toHaveLength(1);
});
it("差し戻しには確認メモが必要。古い下書き版の確定を拒否する", async () => {
  const s = await setup();
  await expect(
    commitReviewDraft(db, clock, s.actor, s.v.id, { revision: 0, decision: "rejected", requestKey: randomUUID() }),
  ).rejects.toThrow("確認メモ");
  await saveReviewDraft(db, clock, s.actor, s.v.id, 0, { note: "   " });
  await expect(
    commitReviewDraft(db, clock, s.actor, s.v.id, { revision: 1, decision: "rejected", requestKey: randomUUID() }),
  ).rejects.toThrow("確認メモ");
  await saveReviewDraft(db, clock, s.actor, s.v.id, 1, complete);
  await expect(
    commitReviewDraft(db, clock, s.actor, s.v.id, { revision: 1, decision: "approved", requestKey: randomUUID() }),
  ).rejects.toBeInstanceOf(ReviewDraftConflict);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
it("新版ができても旧版の入力を保存できるが、確定・新版へのメモ持ち越しはしない", async () => {
  const s = await setup();
  const [newer] = await db
    .insert(proposalVersions)
    .values({ proposalId: s.p.id, version: 2, status: "in_review" })
    .returning();
  await saveReviewDraft(db, clock, s.actor, s.v.id, 0, complete);
  await expect(
    commitReviewDraft(db, clock, s.actor, s.v.id, { revision: 1, decision: "approved", requestKey: randomUUID() }),
  ).rejects.toThrow("新しい提案版");
  expect((await loadReviewDraft(db, s.actor, s.v.id)).values).toEqual(complete);
  expect((await loadReviewDraft(db, s.actor, newer!.id)).values).toBeNull();
  expect(await db.select().from(auditEvents)).toHaveLength(0);
  expect(await db.select().from(proposalReviewSubmissions)).toHaveLength(0);
});
it("受付保存の失敗ではレビュー・下書き消込・監査履歴も戻る", async () => {
  const s = await setup();
  await saveReviewDraft(db, clock, s.actor, s.v.id, 0, complete);
  await db.execute(
    sql`create function fail_review_receipt() returns trigger language plpgsql as $$ begin raise exception 'fixture failure'; end; $$`,
  );
  await db.execute(
    sql`create trigger fail_review_receipt before insert on proposal_review_submissions for each row execute function fail_review_receipt()`,
  );
  await expect(
    commitReviewDraft(db, clock, s.actor, s.v.id, { revision: 1, decision: "rejected", requestKey: randomUUID() }),
  ).rejects.toThrow();
  expect((await loadReviewDraft(db, s.actor, s.v.id)).values).toEqual(complete);
  expect((await db.select().from(proposalVersions).where(eq(proposalVersions.id, s.v.id)))[0]!.status).toBe(
    "in_review",
  );
  expect((await db.select().from(companies).where(eq(companies.id, s.c.id)))[0]!.pipelineStatus).toBe("in_review");
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
it.each(["anonymous", "sales", "suspended", "missing"])("%sからの閲覧・保存・確定を拒否する", async (kind) => {
  const s = await setup();
  const actor =
    kind === "anonymous"
      ? null
      : kind === "sales"
        ? (await seedUser(db, "sales")).actor
        : kind === "missing"
          ? { kind: "ops" as const, userId: randomUUID() }
          : s.actor;
  if (kind === "suspended") await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.user.id));
  await expect(loadReviewDraft(db, actor, s.v.id)).rejects.toThrow("運営");
  await expect(saveReviewDraft(db, clock, actor, s.v.id, 0, complete)).rejects.toThrow("運営");
  await expect(
    commitReviewDraft(db, clock, actor, s.v.id, { revision: 0, decision: "approved", requestKey: randomUUID() }),
  ).rejects.toThrow("運営");
  expect(await db.select().from(proposalReviewDrafts)).toHaveLength(0);
});
it("不正な対象・入力・版番号を保存せず、4000文字の途中入力を保持する", async () => {
  const s = await setup();
  for (const input of [
    {},
    [],
    "x",
    { ...complete, other: true },
    { ...complete, company: "yes" },
    { ...complete, note: "x".repeat(4001) },
  ])
    await expect(saveReviewDraft(db, clock, s.actor, s.v.id, 0, input)).rejects.toThrow();
  for (const rev of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])
    await expect(saveReviewDraft(db, clock, s.actor, s.v.id, rev, complete)).rejects.toThrow();
  for (const id of ["bad", randomUUID()])
    await expect(saveReviewDraft(db, clock, s.actor, id, 0, complete)).rejects.toThrow();
  expect(await db.select().from(proposalReviewDrafts)).toHaveLength(0);
  expect(await saveReviewDraft(db, clock, s.actor, s.v.id, 0, { ...complete, note: "x".repeat(4000) })).toMatchObject({
    values: { note: "x".repeat(4000) },
  });
});
it("同じ版の同時保存は一方だけを採用し、同じレビュー再送は一度だけ記録する", async () => {
  const s = await setup();
  const saves = await Promise.allSettled([
    saveReviewDraft(db, clock, s.actor, s.v.id, 0, complete),
    saveReviewDraft(db, clock, s.actor, s.v.id, 0, { ...complete, note: "競合するメモ" }),
  ]);
  expect(saves.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const input = { revision: 1, decision: "approved" as const, requestKey: randomUUID() };
  const results = await Promise.all([
    commitReviewDraft(db, clock, s.actor, s.v.id, input),
    commitReviewDraft(db, clock, s.actor, s.v.id, input),
  ]);
  expect(results[0]!.snapshot).toEqual(results[1]!.snapshot);
  expect(await db.select().from(auditEvents)).toHaveLength(1);
});
it.each([
  ["未実施", null],
  ["不合格", testPrecheck("failed")],
  ["不正な形", { status: "passed" }],
])("AIの事前チェックが%sなら承認できず、差し戻しはできる", async (_, aiCheck) => {
  const s = await setup(aiCheck);
  await seedTerms(db, { version: "t-1", price: 300_000, rewardRule: TEST_RULE });
  await expect(
    commitReviewDraft(db, clock, s.actor, s.v.id, { revision: 0, decision: "approved", requestKey: randomUUID() }),
  ).rejects.toThrow("AIの事前チェック");
  expect((await db.select().from(proposalVersions).where(eq(proposalVersions.id, s.v.id)))[0]!.status).toBe(
    "in_review",
  );
  expect((await db.select().from(companies).where(eq(companies.id, s.c.id)))[0]!.pipelineStatus).toBe("in_review");
  expect(await db.select().from(auditEvents)).toHaveLength(0);
  await saveReviewDraft(db, clock, s.actor, s.v.id, 0, { note: "リンク切れを直してください" });
  const r = await commitReviewDraft(db, clock, s.actor, s.v.id, {
    revision: 1,
    decision: "rejected",
    requestKey: randomUUID(),
  });
  expect(r.sellable).toBeUndefined();
  expect((await db.select().from(proposalVersions).where(eq(proposalVersions.id, s.v.id)))[0]!.status).toBe("rejected");
});
it("承認すると、有効で設定済みの最新の販売条件を自動で選んで営業可能にする", async () => {
  const s = await setup();
  const old = await seedTerms(db, { version: "t-old", price: 200_000, rewardRule: TEST_RULE });
  const latest = await seedTerms(db, { version: "t-latest", price: 300_000, rewardRule: TEST_RULE });
  // 新しくても、無効・未設定の版は選ばない
  await seedTerms(db, { version: "t-inactive", price: 1, rewardRule: TEST_RULE, active: false });
  await seedTerms(db, { version: "t-noprice", price: null, rewardRule: TEST_RULE });
  const order = ["t-old", "t-latest", "t-inactive", "t-noprice"];
  for (const [i, version] of order.entries())
    await db
      .update(productTerms)
      .set({ createdAt: new Date(Date.UTC(2026, 9, 1 + i)) })
      .where(eq(productTerms.version, version));
  const r = await commitReviewDraft(db, clock, s.actor, s.v.id, {
    revision: 0,
    decision: "approved",
    requestKey: randomUUID(),
  });
  expect(r.sellable).toEqual({ ok: true, productTermsVersion: "t-latest" });
  expect((await db.select().from(companies).where(eq(companies.id, s.c.id)))[0]!.pipelineStatus).toBe("sellable");
  expect((await db.select().from(proposalVersions).where(eq(proposalVersions.id, s.v.id)))[0]!.status).toBe("approved");
  const [made] = await db.select().from(auditEvents).where(eq(auditEvents.action, "company.make_sellable"));
  expect(made!.after).toMatchObject({
    productTermsId: latest.id,
    proposalVersionId: s.v.id,
    via: "final_review",
    termsSelection: "latest_ready",
  });
  expect(made!.after).not.toMatchObject({ productTermsId: old.id });
});
it("販売条件が無ければ承認だけを確定し、営業可能にできない理由を返す", async () => {
  const s = await setup();
  await seedTerms(db, { version: "t-inactive", price: 300_000, rewardRule: TEST_RULE, active: false });
  const r = await commitReviewDraft(db, clock, s.actor, s.v.id, {
    revision: 0,
    decision: "approved",
    requestKey: randomUUID(),
  });
  expect(r.sellable).toMatchObject({ ok: false, reason: expect.stringContaining("販売条件") });
  expect((await db.select().from(proposalVersions).where(eq(proposalVersions.id, s.v.id)))[0]!.status).toBe("approved");
  expect((await db.select().from(companies).where(eq(companies.id, s.c.id)))[0]!.pipelineStatus).toBe("in_review");
  expect((await db.select().from(auditEvents)).map((e) => e.action)).toEqual(["proposal_version.approve"]);
  expect(await db.select().from(proposalReviewSubmissions)).toHaveLength(1);
});
it("営業可能化が途中で失敗しても、承認・受付は確定し、営業可能化の書き込みだけを戻す", async () => {
  const s = await setup();
  await seedTerms(db, { version: "t-1", price: 300_000, rewardRule: TEST_RULE });
  await db.execute(
    sql`create function fail_sales_offer() returns trigger language plpgsql as $$ begin raise exception 'fixture failure'; end; $$`,
  );
  await db.execute(
    sql`create trigger fail_sales_offer before insert on sales_offers for each row execute function fail_sales_offer()`,
  );
  const r = await commitReviewDraft(db, clock, s.actor, s.v.id, {
    revision: 0,
    decision: "approved",
    requestKey: randomUUID(),
  });
  expect(r.sellable).toMatchObject({ ok: false });
  expect((await db.select().from(proposalVersions).where(eq(proposalVersions.id, s.v.id)))[0]!.status).toBe("approved");
  expect((await db.select().from(companies).where(eq(companies.id, s.c.id)))[0]!.pipelineStatus).toBe("in_review");
  expect((await db.select().from(auditEvents)).map((e) => e.action)).toEqual(["proposal_version.approve"]);
  expect(await db.select().from(proposalReviewSubmissions)).toHaveLength(1);
});
it("以前の形式（確認チェック付き）の下書きはメモだけを読み出す", async () => {
  const s = await setup();
  await db.insert(proposalReviewDrafts).values({
    userId: s.user.id,
    proposalVersionId: s.v.id,
    revision: 1,
    values: { note: "旧メモ", company: true, rights: true, devices: false, links: false, continuity: false },
    updatedAt: clock.now(),
  });
  expect((await loadReviewDraft(db, s.actor, s.v.id)).values).toEqual({ note: "旧メモ" });
});
