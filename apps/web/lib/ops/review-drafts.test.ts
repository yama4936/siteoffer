import { randomUUID } from "node:crypto";
import { fixedClock } from "@siteoffer/core";
import {
  auditEvents,
  companies,
  type Db,
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
import { seedUser } from "./test-seed";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
const complete = {
  note: "  引き継ぎ事項\n続き  ",
  company: true,
  rights: true,
  devices: true,
  links: true,
  continuity: true,
};
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
async function setup() {
  const { actor, user } = await seedUser(db, "ops");
  const [c] = await db
    .insert(companies)
    .values({ name: "架空・レビュー下書き", pipelineStatus: "in_review" })
    .returning();
  const [p] = await db.insert(proposals).values({ companyId: c!.id }).returning();
  const [v] = await db
    .insert(proposalVersions)
    .values({ proposalId: p!.id, version: 1, status: "in_review" })
    .returning();
  return { actor, user, c: c!, p: p!, v: v! };
}
it("途中のメモとチェックをそのまま復元し、担当者・企業・版を分離する", async () => {
  const s = await setup();
  const values = { ...EMPTY_REVIEW, company: true, note: "  入力途中\n続き  " };
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
    expect(first).toMatchObject({ revision: 2, values: null });
    expect(await commitReviewDraft(db, clock, s.actor, s.v.id, input)).toEqual(first);
    expect(
      await commitReviewDraft(db, clock, s.actor, s.v.id, { ...input, requestKey: input.requestKey.toUpperCase() }),
    ).toEqual(first);
    expect(await db.select().from(proposalReviewSubmissions)).toHaveLength(1);
    const events = await db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe(decision === "approved" ? "proposal_version.approve" : "proposal_version.reject");
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
it("チェック不足・差し戻し理由なし・古い下書き版の確定を拒否する", async () => {
  const s = await setup();
  await saveReviewDraft(db, clock, s.actor, s.v.id, 0, EMPTY_REVIEW);
  for (const decision of ["approved", "rejected"] as const)
    await expect(
      commitReviewDraft(db, clock, s.actor, s.v.id, { revision: 1, decision, requestKey: randomUUID() }),
    ).rejects.toThrow();
  await saveReviewDraft(db, clock, s.actor, s.v.id, 1, complete);
  await expect(
    commitReviewDraft(db, clock, s.actor, s.v.id, { revision: 1, decision: "approved", requestKey: randomUUID() }),
  ).rejects.toBeInstanceOf(ReviewDraftConflict);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
it("新版ができても旧版の入力を保存できるが、確定・新版へのチェック持ち越しはしない", async () => {
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
  expect(results[0]).toEqual(results[1]);
  expect(await db.select().from(auditEvents)).toHaveLength(1);
});
