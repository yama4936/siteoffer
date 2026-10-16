import { randomUUID } from "node:crypto";
import {
  auditEvents,
  companies,
  contentEntries,
  contentOperations,
  contentRevisions,
  contentWorkingCopies,
  type Db,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import { publishArticle, publishedArticles, saveArticle } from "./content.ts";
import {
  ArticleCopyConflict,
  type ArticleValues,
  ArticleWorkspaceConflict,
  loadArticleWorkspace,
  saveArticleWorkingCopy,
  submitArticleOperation,
} from "./content-workspace.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
const values: ArticleValues = {
  slug: "first",
  title: "見出し",
  body: "入力中の本文",
  category: "news",
  baseRevision: "0",
};
async function setup() {
  const operators = await db
    .insert(users)
    .values(
      [1, 2].map((n) => ({
        email: `${randomUUID()}@example.test`,
        passwordHash: "x",
        displayName: `架空運営${n}`,
        role: "ops" as const,
      })),
    )
    .returning();
  const [company, other] = await db
    .insert(companies)
    .values([{ name: "架空・記事編集" }, { name: "架空・別企業" }])
    .returning();
  return {
    ops: { kind: "ops" as const, userId: operators[0]!.id },
    otherOps: { kind: "ops" as const, userId: operators[1]!.id },
    scope: { companyId: company!.id, entryId: null as string | null },
    otherCompany: other!.id,
  };
}
async function create(s: Awaited<ReturnType<typeof setup>>) {
  await saveArticleWorkingCopy(db, clock, s.ops, s.scope, 0, values);
  const request = { kind: "save" as const, requestId: randomUUID(), copyRevision: 1 };
  const result = await submitArticleOperation(db, clock, s.ops, s.scope, request);
  return { ...result, request };
}
it("自動保存は担当者・企業・記事ごとに非公開で、未完成の入力も復元できる", async () => {
  const s = await setup();
  const draft = { ...values, title: "", body: "途中" };
  await saveArticleWorkingCopy(db, clock, s.ops, s.scope, 0, draft);
  expect((await loadArticleWorkspace(db, s.ops, s.scope)).copy.values).toEqual(draft);
  expect((await loadArticleWorkspace(db, s.otherOps, s.scope)).copy.values).toBeNull();
  expect((await loadArticleWorkspace(db, s.ops, { ...s.scope, companyId: s.otherCompany })).copy.values).toBeNull();
  expect(await db.select().from(contentEntries)).toHaveLength(0);
  expect(await publishedArticles(db, s.scope.companyId)).toEqual([]);
});
it("二つのタブの上書きと破棄後の遅延保存を拒否し、墓標版を保持する", async () => {
  const s = await setup();
  await saveArticleWorkingCopy(db, clock, s.ops, s.scope, 0, values);
  await expect(
    saveArticleWorkingCopy(db, clock, s.ops, s.scope, 0, { ...values, body: "別タブ" }),
  ).rejects.toBeInstanceOf(ArticleCopyConflict);
  await saveArticleWorkingCopy(db, clock, s.ops, s.scope, 1, null);
  await expect(saveArticleWorkingCopy(db, clock, s.ops, s.scope, 1, values)).rejects.toMatchObject({
    snapshot: { revision: 2, values: null },
  });
});
it("共有保存は作業コピーを消費し、一度の受付から一記事・一版だけ作る", async () => {
  const s = await setup(),
    r = await create(s);
  const again = await submitArticleOperation(db, clock, s.ops, s.scope, r.request);
  expect(again.replayed).toBe(true);
  expect(again.workspace.scope.entryId).toBe(r.workspace.scope.entryId);
  expect((await loadArticleWorkspace(db, s.ops, s.scope)).copy).toMatchObject({ revision: 2, values: null });
  expect(await db.select().from(contentEntries)).toHaveLength(1);
  expect(await db.select().from(contentRevisions)).toHaveLength(1);
  expect(await db.select().from(contentOperations)).toHaveLength(1);
  expect(await db.select().from(auditEvents)).toHaveLength(1);
  await expect(submitArticleOperation(db, clock, s.ops, s.scope, { ...r.request, copyRevision: 2 })).rejects.toThrow(
    "受付番号",
  );
});
it("応答を失った保存を再送しても、その後の自分の作業コピーは消さない", async () => {
  const s = await setup(),
    r = await create(s),
    scope = r.workspace.scope;
  await saveArticleWorkingCopy(db, clock, s.ops, scope, 0, { ...r.workspace.current, body: "次の作業" });
  const replay = await submitArticleOperation(db, clock, s.ops, s.scope, r.request);
  expect(replay.workspace.copy.values?.body).toBe("次の作業");
  await saveArticleWorkingCopy(db, clock, s.ops, s.scope, 2, { ...values, slug: "next" });
  await submitArticleOperation(db, clock, s.ops, s.scope, r.request);
  expect((await loadArticleWorkspace(db, s.ops, s.scope)).copy.values?.slug).toBe("next");
});
it("別担当者の更新を比較し、明示した新しい基準版でのみ自分の入力を保存する", async () => {
  const s = await setup(),
    r = await create(s),
    scope = r.workspace.scope;
  await saveArticleWorkingCopy(db, clock, s.ops, scope, 0, { ...r.workspace.current, body: "自分の変更" });
  await saveArticle(db, clock, s.otherOps, {
    companyId: scope.companyId,
    entryId: scope.entryId!,
    expectedRevision: 1,
    ...values,
    body: "別担当の変更",
  });
  await expect(
    submitArticleOperation(db, clock, s.ops, scope, { kind: "save", requestId: randomUUID(), copyRevision: 1 }),
  ).rejects.toBeInstanceOf(ArticleWorkspaceConflict);
  const latest = await loadArticleWorkspace(db, s.ops, scope);
  expect(latest.current.body).toBe("別担当の変更");
  expect(latest.copy.values?.body).toBe("自分の変更");
  await saveArticleWorkingCopy(db, clock, s.ops, scope, 1, { ...latest.copy.values!, baseRevision: "2" });
  const merged = await submitArticleOperation(db, clock, s.ops, scope, {
    kind: "save",
    requestId: randomUUID(),
    copyRevision: 2,
  });
  expect(merged.savedRevision).toBe(3);
  expect(merged.workspace.current.body).toBe("自分の変更");
  expect(merged.workspace.history.find((x) => x.revision === 2)?.body).toBe("別担当の変更");
});
it("他タブで共有保存・破棄された作業コピーから二重に版を作らない", async () => {
  const s = await setup(),
    r = await create(s),
    scope = r.workspace.scope;
  await saveArticleWorkingCopy(db, clock, s.ops, scope, 0, { ...r.workspace.current, body: "編集中" });
  await saveArticleWorkingCopy(db, clock, s.ops, scope, 1, null);
  await expect(
    submitArticleOperation(db, clock, s.ops, scope, { kind: "save", requestId: randomUUID(), copyRevision: 1 }),
  ).rejects.toBeInstanceOf(ArticleWorkspaceConflict);
  expect(await db.select().from(contentRevisions)).toHaveLength(1);
});
it("掲載変更も競合を検出し、停止して同じ版を再掲載した場合の古い操作も拒否する", async () => {
  const s = await setup(),
    r = await create(s),
    scope = r.workspace.scope;
  const input = {
    kind: "publish" as const,
    requestId: randomUUID(),
    expectedRevision: 1,
    expectedPublicationRevision: 0,
    revision: 1,
    confirmed: true,
  };
  const published = await submitArticleOperation(db, clock, s.ops, scope, input);
  expect(published.workspace.publicationRevision).toBe(1);
  await expect(
    submitArticleOperation(db, clock, s.otherOps, scope, { ...input, requestId: randomUUID() }),
  ).rejects.toBeInstanceOf(ArticleWorkspaceConflict);
  await submitArticleOperation(db, clock, s.ops, scope, {
    ...input,
    requestId: randomUUID(),
    expectedPublicationRevision: 1,
    revision: null,
  });
  await submitArticleOperation(db, clock, s.ops, scope, {
    ...input,
    requestId: randomUUID(),
    expectedPublicationRevision: 2,
  });
  await expect(
    submitArticleOperation(db, clock, s.ops, scope, {
      ...input,
      requestId: randomUUID(),
      expectedPublicationRevision: 1,
      revision: null,
    }),
  ).rejects.toBeInstanceOf(ArticleWorkspaceConflict);
  const again = await submitArticleOperation(db, clock, s.ops, scope, input);
  expect(again.replayed).toBe(true);
  expect(again.workspace.publicationRevision).toBe(3);
  expect(await db.select().from(auditEvents)).toHaveLength(4);
});
it("同じ掲載版への反映は掲載日や監査履歴を増やさず、別企業の記事は拒否する", async () => {
  const s = await setup(),
    r = await create(s),
    scope = r.workspace.scope;
  const input = {
    companyId: scope.companyId,
    entryId: scope.entryId!,
    expectedRevision: 1,
    expectedPublicationRevision: 0,
    revision: 1,
  };
  const e = await publishArticle(db, clock, s.ops, input);
  expect(e.publishedRevision).toBe(1);
  const same = await publishArticle(db, fixedClock("2026-10-18T00:00:00Z"), s.ops, {
    ...input,
    expectedPublicationRevision: 1,
  });
  expect(same.publishedAt).toEqual(e.publishedAt);
  expect(same.publicationRevision).toBe(1);
  await expect(publishArticle(db, clock, s.ops, { ...input, companyId: s.otherCompany })).rejects.toThrow(
    "記事がありません",
  );
  await expect(loadArticleWorkspace(db, s.ops, { ...scope, companyId: s.otherCompany })).rejects.toThrow(
    "記事がありません",
  );
  expect(await db.select().from(auditEvents)).toHaveLength(2);
});
it("認証と有効な運営権限を全読込・保存・再送で確認する", async () => {
  const s = await setup(),
    r = await create(s);
  await expect(loadArticleWorkspace(db, null, s.scope)).rejects.toThrow("運営権限");
  await expect(
    saveArticleWorkingCopy(db, clock, { kind: "sales", userId: s.ops.userId }, s.scope, 2, values),
  ).rejects.toThrow("運営権限");
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  await expect(loadArticleWorkspace(db, s.ops, s.scope)).rejects.toThrow("有効な運営");
  await expect(saveArticleWorkingCopy(db, clock, s.ops, s.scope, 2, values)).rejects.toThrow("有効な運営");
  await expect(submitArticleOperation(db, clock, s.ops, s.scope, r.request)).rejects.toThrow("有効な運営");
});
it("入力検査と保存失敗で本文を保持し、共有版と受付記録を部分保存しない", async () => {
  const s = await setup();
  for (const v of [
    { ...values, body: "\0" },
    { ...values, category: "bad" },
    { ...values, extra: true },
    { ...values, baseRevision: "1" },
  ])
    await expect(saveArticleWorkingCopy(db, clock, s.ops, s.scope, 0, v)).rejects.toThrow();
  await saveArticleWorkingCopy(db, clock, s.ops, s.scope, 0, { ...values, slug: "INVALID" });
  await expect(
    submitArticleOperation(db, clock, s.ops, s.scope, { kind: "save", requestId: randomUUID(), copyRevision: 1 }),
  ).rejects.toThrow("URL名");
  expect((await loadArticleWorkspace(db, s.ops, s.scope)).copy.values?.body).toBe(values.body);
  expect(await db.select().from(contentEntries)).toHaveLength(0);
  expect(await db.select().from(contentOperations)).toHaveLength(0);
  await saveArticleWorkingCopy(db, clock, s.ops, s.scope, 1, values);
  await db.execute(
    sql`create function reject_content_receipt() returns trigger language plpgsql as $$ begin raise exception 'qa rollback'; end; $$`,
  );
  await db.execute(
    sql`create trigger reject_content_receipt before insert on content_operations for each row execute function reject_content_receipt()`,
  );
  await expect(
    submitArticleOperation(db, clock, s.ops, s.scope, { kind: "save", requestId: randomUUID(), copyRevision: 2 }),
  ).rejects.toMatchObject({ cause: { message: "qa rollback" } });
  expect(await db.select().from(contentEntries)).toHaveLength(0);
  expect(await db.select().from(contentRevisions)).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
  expect((await db.select().from(contentWorkingCopies))[0]?.values).toEqual(values);
});

it("掲載の確認・正しい版・受付形式がなければ掲載せず、不正な再送も拒否する", async () => {
  const s = await setup(),
    r = await create(s),
    scope = r.workspace.scope;
  const valid = {
    kind: "publish" as const,
    requestId: randomUUID(),
    expectedRevision: 1,
    expectedPublicationRevision: 0,
    revision: 1,
    confirmed: true,
  };
  for (const patch of [
    { confirmed: false },
    { revision: 0 },
    { revision: NaN },
    { expectedPublicationRevision: -1 },
    { extra: true },
  ])
    await expect(submitArticleOperation(db, clock, s.ops, scope, { ...valid, ...patch })).rejects.toThrow(
      "掲載する内容",
    );
  expect(await publishedArticles(db, s.scope.companyId)).toEqual([]);
  await submitArticleOperation(db, clock, s.ops, scope, valid);
  await expect(submitArticleOperation(db, clock, s.ops, scope, { ...valid, revision: NaN })).rejects.toThrow(
    "掲載する内容",
  );
});
