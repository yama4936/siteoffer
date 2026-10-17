import { randomUUID } from "node:crypto";
import { companies, contentAccess, contentEntries, contentRevisions, contracts, type Db, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import { loadArticleHistory, loadArticleRevision } from "./content-history.ts";
import { loadArticleWorkspace, saveArticleWorkingCopy } from "./content-workspace.ts";
import { seedDeliveryBase } from "./delivery/test-helpers.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
async function seed(n = 5) {
  const [operator] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test`, passwordHash: "fixture", displayName: "架空運営", role: "ops" })
    .returning();
  const [company, other] = await db
    .insert(companies)
    .values([{ name: "架空の記事履歴" }, { name: "架空の別会社" }])
    .returning();
  const [entry] = await db
    .insert(contentEntries)
    .values({
      companyId: company!.id,
      slug: "history",
      currentRevision: n,
      publishedRevision: 1,
      updatedAt: clock.now(),
    })
    .returning();
  await db.insert(contentRevisions).values(
    Array.from({ length: n }, (_, i) => ({
      entryId: entry!.id,
      revision: i + 1,
      title: `見出し${i + 1}`,
      body: `本文${i + 1} ${"x".repeat(10000)}`,
      category: "news",
      createdBy: operator!.id,
    })),
  );
  return {
    actor: { kind: "ops", userId: operator!.id } as const,
    scope: { companyId: company!.id, entryId: entry!.id },
    other: other!.id,
  };
}
describe("記事の版を必要な分だけ読む", () => {
  it("501版から20件の概要と現在・掲載の本文だけを返し、古い版も読める", async () => {
    const s = await seed(501),
      workspace = await loadArticleWorkspace(db, s.actor, s.scope);
    expect(workspace.history).toMatchObject({ total: 501, pageSize: 20, pageCount: 26 });
    expect(workspace.history.items.map((r) => r.revision)).toEqual(Array.from({ length: 20 }, (_, i) => 501 - i));
    expect(workspace.current.body).toMatch(/^本文501 /);
    expect(workspace.published?.body).toMatch(/^本文1 /);
    expect(Buffer.byteLength(JSON.stringify(workspace))).toBeLessThan(100000);
    expect(JSON.stringify(workspace.history)).not.toContain("本文");
    expect(workspace.history.items.every((r) => !("body" in r) && !("images" in r) && !("createdBy" in r))).toBe(true);
    const last = await loadArticleHistory(db, s.actor, s.scope, { page: 26, query: "" });
    expect(last.items.map((r) => r.revision)).toEqual([1]);
    expect(
      (await loadArticleHistory(db, s.actor, s.scope, { page: Number.MAX_SAFE_INTEGER, query: "" })).filters.page,
    ).toBe(26);
    expect((await loadArticleRevision(db, s.actor, s.scope, 10)).body).toMatch(/^本文10 /);
  });
  it("過去の見出し・本文を全履歴から検索し、SQL記号を通常文字として扱う", async () => {
    const s = await seed(30);
    await db
      .update(contentRevisions)
      .set({ title: "old%_\\LAB", body: "初年度だけの文面" })
      .where(eq(contentRevisions.revision, 2));
    for (const query of ["%", "_", "\\", "lab", "初年度"]) {
      const page = await loadArticleHistory(db, s.actor, s.scope, { page: 1, query });
      expect(page.items.map((r) => r.revision)).toEqual([2]);
    }
    const none = await loadArticleHistory(db, s.actor, s.scope, { page: 9, query: "%' OR true --" });
    expect(none).toMatchObject({ total: 0, pageCount: 1, filters: { page: 1 }, items: [] });
  });
  it("履歴・版の読み取りは私用の入力や掲載状態を変更せず、別記事を取り違えない", async () => {
    const s = await seed(),
      initial = await loadArticleWorkspace(db, s.actor, s.scope);
    await saveArticleWorkingCopy(db, clock, s.actor, s.scope, 0, { ...initial.current, body: "入力途中の私用コピー" });
    await loadArticleHistory(db, s.actor, s.scope, { page: 1, query: "本文" });
    expect((await loadArticleRevision(db, s.actor, s.scope, 2)).revision).toBe(2);
    const after = await loadArticleWorkspace(db, s.actor, s.scope);
    expect(after.copy.values?.body).toBe("入力途中の私用コピー");
    expect(after.publishedRevision).toBe(1);
    await expect(loadArticleRevision(db, s.actor, { ...s.scope, companyId: s.other }, 2)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(loadArticleRevision(db, s.actor, s.scope, 100)).rejects.toMatchObject({ code: "not_found" });
  });
  it("未保存の記事にも空の履歴を返す", async () => {
    const s = await seed();
    const next = await loadArticleWorkspace(db, s.actor, { ...s.scope, entryId: null });
    expect(next).toMatchObject({ published: null, history: { total: 0, items: [], pageCount: 1 } });
  });
  it("不正な条件と版・匿名・無効な運営を拒否する", async () => {
    const s = await seed();
    for (const page of [0, 1.5, Infinity])
      await expect(loadArticleHistory(db, s.actor, s.scope, { page, query: "" })).rejects.toMatchObject({
        code: "invalid_input",
      });
    for (const query of ["a\n", "x".repeat(121)])
      await expect(loadArticleHistory(db, s.actor, s.scope, { page: 1, query })).rejects.toMatchObject({
        code: "invalid_input",
      });
    for (const revision of [0, 1.5, Infinity, 2147483648])
      await expect(loadArticleRevision(db, s.actor, s.scope, revision)).rejects.toMatchObject({
        code: "invalid_input",
      });
    await expect(loadArticleRevision(db, null, s.scope, 1)).rejects.toThrow("権限");
    await expect(
      loadArticleHistory(db, { kind: "sales", userId: s.actor.userId }, s.scope, { page: 1, query: "" }),
    ).rejects.toThrow("権限");
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.actor.userId));
    await expect(loadArticleHistory(db, s.actor, s.scope, { page: 1, query: "" })).rejects.toThrow("有効な運営");
  });
  it("顧客は有効な契約の自社履歴だけ読め、利用権限・契約の失効を再検査する", async () => {
    const base = await seedDeliveryBase(db);
    const [customer] = await db
      .insert(users)
      .values({
        email: `${randomUUID()}@example.test`,
        displayName: "架空顧客",
        role: "customer",
        passwordHash: "fixture",
      })
      .returning();
    const [access] = await db
      .insert(contentAccess)
      .values({
        companyId: base.company.id,
        contractId: base.contract.id,
        email: customer!.email,
        userId: customer!.id,
        status: "active",
        tokenHash: randomUUID(),
        requestId: randomUUID(),
        expiresAt: clock.now(),
        createdBy: base.ops.userId,
        updatedAt: clock.now(),
      })
      .returning();
    const [entry] = await db
      .insert(contentEntries)
      .values({ companyId: base.company.id, slug: "customer-history", updatedAt: clock.now() })
      .returning();
    await db.insert(contentRevisions).values({
      entryId: entry!.id,
      revision: 1,
      title: "顧客記事",
      body: "顧客の本文",
      category: "news",
      createdBy: customer!.id,
    });
    const actor = { kind: "customer_user", userId: customer!.id } as const,
      scope = { companyId: base.company.id, entryId: entry!.id };
    expect((await loadArticleRevision(db, actor, scope, 1)).body).toBe("顧客の本文");
    const other = await seed();
    await expect(loadArticleRevision(db, actor, other.scope, 1)).rejects.toThrow("利用できません");
    await db.update(contentAccess).set({ status: "revoked" }).where(eq(contentAccess.id, access!.id));
    await expect(loadArticleHistory(db, actor, scope, { page: 1, query: "" })).rejects.toThrow("利用できません");
    await db.update(contentAccess).set({ status: "active" }).where(eq(contentAccess.id, access!.id));
    await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, base.contract.id));
    await expect(loadArticleRevision(db, actor, scope, 1)).rejects.toThrow("利用契約");
  });
});
