import { randomUUID } from "node:crypto";
import { fixedClock } from "@siteoffer/core";
import { auditEvents, companies, type Db, proposals, proposalVersions, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { reviewProposalVersion } from "./commands";
import { listReviewQueue } from "./queries";
import { getReviewInbox } from "./review-inbox";
import { seedUser } from "./test-seed";

let db: Db;
let close: () => Promise<void>;
let actor: { kind: "ops"; userId: string };
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const u = await seedUser(db, "ops");
  actor = { kind: "ops", userId: u.user.id };
});
afterEach(async () => {
  await close();
});
async function seed(status: "in_review" | "approved" | "generating" | "failed" | "rejected" = "in_review") {
  const [c] = await db
    .insert(companies)
    .values({ name: "架空・レビュー対象", pipelineStatus: "in_review" })
    .returning();
  const [p] = await db.insert(proposals).values({ companyId: c!.id }).returning();
  const [v] = await db
    .insert(proposalVersions)
    .values({
      proposalId: p!.id,
      version: 1,
      status,
      content: { privateBody: "do-not-list" },
      demoArtifactDir: "private-path",
    })
    .returning();
  return { c: c!, p: p!, v: v! };
}
it("205社を全件から検索・20社単位で表示し、200社の外の案件も見つかる", async () => {
  const cs = await db
    .insert(companies)
    .values(
      Array.from({ length: 205 }, (_, i) => ({
        name: i === 204 ? "架空100%確認_205" : `架空レビュー ${i}`,
        prefecture: "愛知県",
        city: "名古屋市",
        industry: "工務店",
        createdAt: new Date(2026, 0, 1 + i),
      })),
    )
    .returning();
  const ps = await db
    .insert(proposals)
    .values(cs.map((c) => ({ companyId: c.id })))
    .returning();
  await db.insert(proposalVersions).values(
    ps.map((p, i) => ({
      proposalId: p.id,
      version: 1,
      status: "in_review" as const,
      createdAt: new Date(2026, 0, 1 + i),
    })),
  );
  const first = await getReviewInbox(db, actor);
  expect(first).toMatchObject({
    ok: true,
    value: { total: 205, pages: 11, page: 1, counts: { all: 205, pending: 205 } },
  });
  expect(first.ok && first.value.items).toHaveLength(20);
  const last = await getReviewInbox(db, actor, { page: 999 });
  expect(last).toMatchObject({ ok: true, value: { page: 11 } });
  expect(last.ok && last.value.items).toHaveLength(5);
  expect(await getReviewInbox(db, actor, { query: "100%確認_" })).toMatchObject({
    ok: true,
    value: { total: 1, items: [{ id: cs[204]!.id }] },
  });
  expect(await getReviewInbox(db, actor, { query: "名古屋市" })).toMatchObject({ ok: true, value: { total: 205 } });
  expect(await getReviewInbox(db, actor, { query: "工務店" })).toMatchObject({ ok: true, value: { total: 205 } });
});
it.each(["approved", "generating", "failed", "rejected"] as const)(
  "新しい%s版があれば古い確認待ちを一覧へ出さない",
  async (status) => {
    const c = await seed();
    const [v] = await db.insert(proposalVersions).values({ proposalId: c.p.id, version: 2, status }).returning();
    expect(await getReviewInbox(db, actor)).toMatchObject({
      ok: true,
      value: { total: 0, counts: { all: 1, pending: 0 } },
    });
    const all = await getReviewInbox(db, actor, { view: "all" });
    expect(all.ok && all.value.items[0]).toMatchObject({
      versionId: v!.id,
      version: 2,
      versionStatus: status,
      pending: false,
    });
    const legacy = await listReviewQueue(db, actor);
    expect(legacy.ok && legacy.value.inReview).toHaveLength(0);
    expect(JSON.stringify(all)).not.toContain("do-not-list");
    expect(JSON.stringify(all)).not.toContain("private-path");
  },
);
it("古い承認済み版があっても最新版が未承認なら営業可能化待ちへ重ねて出さない", async () => {
  const c = await seed("approved");
  await db.insert(proposalVersions).values({ proposalId: c.p.id, version: 2, status: "in_review" });
  const q = await listReviewQueue(db, actor);
  expect(q.ok && q.value.readyCandidates).toHaveLength(0);
  expect(q.ok && q.value.inReview).toHaveLength(1);
});
it("営業抑止中は確認待ちから除き、すべてで状態を示す。提案なしの企業も検索できる", async () => {
  const c = await seed();
  await db.update(companies).set({ suppression: "excluded" }).where(eq(companies.id, c.c.id));
  const [fresh] = await db.insert(companies).values({ name: "未制作の架空企業" }).returning();
  expect(await getReviewInbox(db, actor)).toMatchObject({ ok: true, value: { total: 0 } });
  const all = await getReviewInbox(db, actor, { view: "all" });
  expect(all.ok && all.value.items.find((r) => r.id === c.c.id)).toMatchObject({
    suppression: "excluded",
    pending: false,
  });
  expect(await getReviewInbox(db, actor, { view: "all", query: "未制作" })).toMatchObject({
    ok: true,
    value: { total: 1, items: [{ id: fresh!.id, versionId: null }] },
  });
});
it.each(["approved", "rejected"] as const)(
  "古い確認待ち版への直接%sを拒否し、状態と履歴を変えない",
  async (decision) => {
    const c = await seed();
    await db.insert(proposalVersions).values({ proposalId: c.p.id, version: 2, status: "in_review" });
    expect(
      await reviewProposalVersion({ db, clock }, actor, {
        proposalVersionId: c.v.id,
        decision,
        note: "古い画面からの操作",
      }),
    ).toMatchObject({ ok: false, error: "superseded_version" });
    expect((await db.select().from(proposalVersions).where(eq(proposalVersions.id, c.v.id)))[0]!.status).toBe(
      "in_review",
    );
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  },
);
it("最新版のレビューは通常通り確定できる", async () => {
  const c = await seed();
  const [v] = await db
    .insert(proposalVersions)
    .values({ proposalId: c.p.id, version: 2, status: "in_review" })
    .returning();
  expect(
    await reviewProposalVersion({ db, clock }, actor, {
      proposalVersionId: v!.id,
      decision: "rejected",
      note: "見出しの修正",
    }),
  ).toMatchObject({ ok: true });
  expect(await getReviewInbox(db, actor)).toMatchObject({ ok: true, value: { total: 0 } });
});
it.each(["sales", "suspended", "missing", "anonymous"])("%sには一覧を返さない", async (kind) => {
  await seed();
  if (kind === "suspended") await db.update(users).set({ status: "suspended" });
  const caller =
    kind === "anonymous"
      ? null
      : kind === "sales"
        ? { kind: "sales" as const, userId: actor.userId }
        : kind === "missing"
          ? { kind: "ops" as const, userId: randomUUID() }
          : actor;
  expect(await getReviewInbox(db, caller)).toMatchObject({ ok: false, error: "forbidden" });
});
it("不正な表示条件を拒否し、空検索とページ範囲を補正する", async () => {
  for (const input of [{ view: "wrong" }, { query: "x".repeat(201) }])
    expect(await getReviewInbox(db, actor, input)).toMatchObject({ ok: false, error: "invalid_input" });
  expect(await getReviewInbox(db, actor, { query: "   ", page: -3 })).toMatchObject({
    ok: true,
    value: { query: "", page: 1, pages: 1, total: 0 },
  });
});
