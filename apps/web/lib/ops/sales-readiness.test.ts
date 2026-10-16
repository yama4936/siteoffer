import { randomUUID } from "node:crypto";
import { fixedClock } from "@siteoffer/core";
import { auditEvents, companies, type Db, productTerms, proposals, proposalVersions, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeSellable, withdrawSellable } from "./commands";
import { getReviewInbox } from "./review-inbox";
import { getSalesReadiness } from "./sales-readiness";
import { seedTerms, seedUser } from "./test-seed";
import { getOpsWorkQueue } from "./work-queue";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
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
    .values({ name: "架空・引き継ぎ", pipelineStatus: "in_review", officialSiteStatus: "confirmed" })
    .returning();
  const [p] = await db.insert(proposals).values({ companyId: c!.id }).returning();
  const [v] = await db
    .insert(proposalVersions)
    .values({ proposalId: p!.id, version: 1, status: "approved" })
    .returning();
  const terms = await seedTerms(db, {
    version: randomUUID(),
    price: 123456,
    rewardRule: { type: "fixed", amount: 12345 },
  });
  return {
    actor,
    user,
    c: c!,
    p: p!,
    v: v!,
    terms,
    input: {
      companyId: c!.id,
      productTermsId: terms.id,
      expectedProposalVersionId: v!.id,
      expectedCompanyUpdatedAt: c!.updatedAt.toISOString(),
      allowExisting: true,
    },
  };
}
it("205社の承認済み案件を全件から検索し、ホームの件数も20件の外まで数える", async () => {
  const { actor } = await seedUser(db, "ops");
  const cs = await db
    .insert(companies)
    .values(
      Array.from({ length: 205 }, (_, i) => ({
        name: `架空引き継ぎ${i === 204 ? "100%_最終" : i}`,
        prefecture: "愛知県",
        city: "名古屋市",
        industry: "工務店",
        officialSiteStatus: "confirmed" as const,
        pipelineStatus: "in_review" as const,
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
      status: "approved" as const,
      createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)),
      content: { internal: "do-not-return" },
      demoArtifactDir: "private-path",
    })),
  );
  const q = await getSalesReadiness(db, actor);
  expect(q).toMatchObject({ ok: true, value: { total: 205, pages: 11, page: 1 } });
  expect(q.ok && q.value.items).toHaveLength(20);
  expect(await getSalesReadiness(db, actor, { query: "100%_" })).toMatchObject({
    ok: true,
    value: { total: 1, items: [{ id: cs[204]!.id }] },
  });
  expect(await getSalesReadiness(db, actor, { query: "工務店", page: 999 })).toMatchObject({
    ok: true,
    value: { total: 205, page: 11 },
  });
  expect(await getSalesReadiness(db, actor, { companyId: cs[204]!.id })).toMatchObject({
    ok: true,
    value: { selected: { id: cs[204]!.id } },
  });
  expect(JSON.stringify(q)).not.toContain("private-path");
  expect(JSON.stringify(q)).not.toContain("do-not-return");
  const home = await getOpsWorkQueue(db, actor, clock);
  expect(home.ok).toBe(true);
  if (home.ok) {
    expect(home.value.groups.find((g) => g.key === "sales_ready")?.count).toBe(205);
    expect(home.value.items.filter((r) => r.group === "sales_ready")).toHaveLength(20);
  }
});
it("最新版未承認・営業抑止・営業可能済みを候補から除き、指定案件は現在の状態を返す", async () => {
  const s = await setup();
  await db.insert(proposalVersions).values({ proposalId: s.p.id, version: 2, status: "in_review" });
  expect(await getSalesReadiness(db, s.actor, { companyId: s.c.id })).toMatchObject({
    ok: true,
    value: { total: 0, selected: { version: 2, versionStatus: "in_review" } },
  });
  await db.update(proposalVersions).set({ status: "approved" });
  await db.update(companies).set({ suppression: "excluded" });
  expect(await getReviewInbox(db, s.actor, { view: "ready" })).toMatchObject({ ok: true, value: { total: 0 } });
  await db.update(companies).set({ suppression: "none", pipelineStatus: "sellable" });
  expect(await getSalesReadiness(db, s.actor, { companyId: s.c.id })).toMatchObject({
    ok: true,
    value: { total: 0, selected: { status: "sellable" } },
  });
});
it("選択肢は有効な条件だけを返し、価格・報酬未設定は使用不可として示す", async () => {
  const s = await setup();
  await seedTerms(db, { version: "inactive", active: false, price: 1, rewardRule: { type: "fixed", amount: 1 } });
  await seedTerms(db, { version: "incomplete", price: null, rewardRule: null });
  const q = await getSalesReadiness(db, s.actor);
  expect(q.ok).toBe(true);
  if (q.ok) {
    expect(q.value.terms).toHaveLength(2);
    expect(q.value.terms.find((t) => t.version === "incomplete")?.ready).toBe(false);
    expect(q.value.terms.find((t) => t.id === s.terms.id)).toMatchObject({ ready: true, price: "123,456円" });
  }
});
it.each(["approved", "in_review"] as const)("確認した後に新しい%s版ができた場合は営業可能化しない", async (status) => {
  const s = await setup();
  await db.insert(proposalVersions).values({ proposalId: s.p.id, version: 2, status });
  expect(await makeSellable({ db, clock }, s.actor, s.input)).toMatchObject({ ok: false, error: "proposal_changed" });
  expect((await db.select().from(companies).where(eq(companies.id, s.c.id)))[0]!.pipelineStatus).toBe("in_review");
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});
it("条件が無効になった場合は拒否し、有効な同一対象の再送は監査を増やさない", async () => {
  const s = await setup();
  await db.update(productTerms).set({ active: false }).where(eq(productTerms.id, s.terms.id));
  expect(await makeSellable({ db, clock }, s.actor, s.input)).toMatchObject({ ok: false, error: "terms_not_ready" });
  await db.update(productTerms).set({ active: true }).where(eq(productTerms.id, s.terms.id));
  expect(
    await makeSellable({ db, clock }, s.actor, { ...s.input, expectedProposalVersionId: s.v.id.toUpperCase() }),
  ).toMatchObject({ ok: true });
  expect(await makeSellable({ db, clock }, s.actor, s.input)).toMatchObject({ ok: true });
  expect(await db.select().from(auditEvents)).toHaveLength(1);
  const other = await seedTerms(db, { version: "other", price: 100, rewardRule: { type: "fixed", amount: 1 } });
  expect(await makeSellable({ db, clock }, s.actor, { ...s.input, productTermsId: other.id })).toMatchObject({
    ok: false,
    error: "company_changed",
  });
});
it("監査保存が失敗した場合は営業可能状態も戻る", async () => {
  const s = await setup();
  await db.execute(
    sql`create function fail_sales_ready() returns trigger language plpgsql as $$ begin raise exception 'fixture failure'; end; $$`,
  );
  await db.execute(
    sql`create trigger fail_sales_ready before insert on audit_events for each row execute function fail_sales_ready()`,
  );
  await expect(makeSellable({ db, clock }, s.actor, s.input)).rejects.toThrow();
  expect((await db.select().from(companies).where(eq(companies.id, s.c.id)))[0]!.pipelineStatus).toBe("in_review");
});
it.each(["sales", "suspended", "missing", "anonymous"])(
  "%sには候補・条件を返さず営業可能化も許可しない",
  async (kind) => {
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
    expect(await getSalesReadiness(db, actor)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await makeSellable({ db, clock }, actor, s.input)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  },
);
it("不正な検索・対象・提案版をDBへ渡す前に拒否する", async () => {
  const s = await setup();
  for (const input of [{ query: "x".repeat(201) }, { companyId: "bad" }])
    expect(await getSalesReadiness(db, s.actor, input)).toMatchObject({ ok: false, error: "invalid_input" });
  for (const patch of [
    { expectedCompanyUpdatedAt: "bad" },
    { expectedProposalVersionId: "" },
    { companyId: "bad" },
    { productTermsId: "bad" },
  ])
    expect(await makeSellable({ db, clock }, s.actor, { ...s.input, ...patch })).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
});

it("応答消失後に取り下げられた案件は古い再試行で営業可能へ戻さない", async () => {
  const s = await setup();
  const deps = { db, clock };
  expect(await makeSellable(deps, s.actor, s.input)).toMatchObject({ ok: true });
  expect(
    await withdrawSellable({ db, clock: fixedClock("2026-10-17T00:01:00Z") }, s.actor, {
      companyId: s.c.id,
      reason: "確認のため保留",
    }),
  ).toMatchObject({ ok: true });
  expect(await makeSellable(deps, s.actor, s.input)).toMatchObject({ ok: false, error: "company_changed" });
  const [current] = await db.select().from(companies).where(eq(companies.id, s.c.id));
  expect(current!.pipelineStatus).toBe("on_hold");
  expect(await db.select().from(auditEvents)).toHaveLength(2);
  expect(
    await makeSellable(deps, s.actor, { ...s.input, expectedCompanyUpdatedAt: current!.updatedAt.toISOString() }),
  ).toMatchObject({ ok: true });
});
