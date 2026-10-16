import { randomUUID } from "node:crypto";
import { auditEvents, contentAccess, contracts, type Db, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hashToken, verifyPassword } from "./auth/crypto.ts";
import { createLocalAuthProvider } from "./auth/local-provider.ts";
import { reactivateUser, suspendUser } from "./auth/users.ts";
import { fixedClock } from "./common/clock.ts";
import { publishArticle, publishedArticles, saveArticle } from "./content.ts";
import {
  acceptContentInvitation,
  inspectContentInvitation,
  inviteContentEditor,
  listCustomerContentCompanies,
  loadContentAccess,
  loadCustomerArticles,
  revokeContentEditor,
} from "./content-access.ts";
import { loadArticleWorkspace, saveArticleWorkingCopy, submitArticleOperation } from "./content-workspace.ts";
import { seedDeliveryBase } from "./delivery/test-helpers.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z"),
  password = "customer-test-password-42";
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
async function setup() {
  const b = await seedDeliveryBase(db);
  return {
    ...b,
    input: {
      companyId: b.company.id,
      contractId: b.contract.id,
      email: `${randomUUID()}@example.test`,
      expectedRevision: 0,
      requestId: randomUUID(),
      confirmed: true,
    },
  };
}
async function invite(s: Awaited<ReturnType<typeof setup>>) {
  const r = await inviteContentEditor(db, clock, s.ops, s.input);
  expect(r.token).not.toBeNull();
  return r;
}
async function activate(s: Awaited<ReturnType<typeof setup>>) {
  const r = await invite(s),
    account = await acceptContentInvitation(db, clock, {
      token: r.token!,
      displayName: "架空顧客",
      password,
      confirmed: true,
    });
  return { ...r, ...account, actor: { kind: "customer_user" as const, userId: account.userId } };
}
it("招待は完了契約と明示確認を必要とし、秘密の案内URLをDB・監査・管理一覧に残さない", async () => {
  const s = await setup();
  await expect(inviteContentEditor(db, clock, s.sales, s.input)).rejects.toThrow("運営権限");
  await expect(inviteContentEditor(db, clock, s.ops, { ...s.input, confirmed: false })).rejects.toThrow("確認チェック");
  await db.update(contracts).set({ status: "under_review" }).where(eq(contracts.id, s.contract.id));
  await expect(invite(s)).rejects.toThrow("完了契約");
  await db.update(contracts).set({ status: "completed" }).where(eq(contracts.id, s.contract.id));
  const r = await invite(s),
    row = (await db.select().from(contentAccess))[0]!;
  expect(row.tokenHash).toBe(hashToken(r.token!));
  expect(JSON.stringify(await db.select().from(contentAccess))).not.toContain(r.token!);
  expect(JSON.stringify(await db.select().from(auditEvents))).not.toContain(r.token!);
  expect(JSON.stringify(await loadContentAccess(db, s.ops, s.company.id))).not.toContain(row.tokenHash);
  expect(await inspectContentInvitation(db, clock, r.token!)).toMatchObject({
    companyName: s.company.name,
    email: s.input.email,
    existingAccount: false,
  });
  const again = await inviteContentEditor(db, clock, s.ops, s.input);
  expect(again).toMatchObject({ token: null, replayed: true, access: { id: r.access.id } });
  expect(await db.select().from(contentAccess)).toHaveLength(1);
});
it("期限切れ・取消・再発行前の招待と古い画面からの取消を拒否する", async () => {
  const s = await setup(),
    r = await invite(s),
    later = fixedClock("2026-10-20T00:00:00Z");
  expect(await inspectContentInvitation(db, later, r.token!)).toBeNull();
  await expect(
    acceptContentInvitation(db, later, { token: r.token!, displayName: "顧客", password, confirmed: true }),
  ).rejects.toThrow("期限切れ");
  const revoked = await revokeContentEditor(db, clock, s.ops, {
    companyId: s.company.id,
    accessId: r.access.id,
    revision: 1,
  });
  expect(await inspectContentInvitation(db, clock, r.token!)).toBeNull();
  const next = await inviteContentEditor(db, clock, s.ops, {
    ...s.input,
    requestId: randomUUID(),
    expectedRevision: revoked.revision,
  });
  expect(await inspectContentInvitation(db, clock, r.token!)).toBeNull();
  expect(await inspectContentInvitation(db, clock, next.token!)).not.toBeNull();
  await expect(
    revokeContentEditor(db, clock, s.ops, { companyId: s.company.id, accessId: r.access.id, revision: 1 }),
  ).rejects.toThrow("変更されています");
});
it("顧客本人がパスワードを設定し、認証・セッション・監査が顧客の役割になる", async () => {
  const s = await setup(),
    a = await activate(s),
    provider = createLocalAuthProvider({ db, clock }),
    login = await provider.login({ email: s.input.email, password });
  expect(login.ok && login.value.user).toMatchObject({ role: "customer", actor: a.actor });
  if (!login.ok) throw Error("login");
  expect(await provider.authenticate(login.value.token)).toMatchObject({ ok: true, value: { actor: a.actor } });
  const [user] = await db.select().from(users).where(eq(users.id, a.userId));
  expect(user!.passwordHash).not.toBe(password);
  expect(await verifyPassword(password, user!.passwordHash)).toBe(true);
  const replay = await acceptContentInvitation(db, clock, {
    token: a.token!,
    displayName: "変えない",
    password,
    confirmed: true,
  });
  expect(replay.replayed).toBe(true);
  expect(await db.select().from(users).where(eq(users.email, s.input.email))).toHaveLength(1);
  await expect(
    acceptContentInvitation(db, clock, {
      token: a.token!,
      displayName: "変更不可",
      password: "another-password-42",
      confirmed: true,
    }),
  ).rejects.toThrow("登録済み");
  await provider.logout(login.value.token);
  expect(await provider.authenticate(login.value.token)).toMatchObject({ ok: false });
  const events = await db.select().from(auditEvents);
  expect(events.filter((e) => e.action === "content_access.accept")).toHaveLength(1);
  expect(events.find((e) => e.action === "session.deleted")?.actorKind).toBe("customer_user");
});
it("自社の記事だけを自動保存・共有保存・掲載でき、他社の本文と私用コピーを読めない", async () => {
  const s = await setup(),
    a = await activate(s),
    other = await setup(),
    scope = { companyId: s.company.id, entryId: null };
  const values = { slug: "notice", title: "顧客のお知らせ", body: "掲載する本文", category: "news", baseRevision: "0" };
  await saveArticleWorkingCopy(db, clock, a.actor, scope, 0, values);
  expect((await loadArticleWorkspace(db, s.ops, scope)).copy.values).toBeNull();
  const saved = await submitArticleOperation(db, clock, a.actor, scope, {
    kind: "save",
    requestId: randomUUID(),
    copyRevision: 1,
  });
  expect(await publishedArticles(db, s.company.id)).toEqual([]);
  await submitArticleOperation(db, clock, a.actor, saved.workspace.scope, {
    kind: "publish",
    requestId: randomUUID(),
    expectedRevision: 1,
    expectedPublicationRevision: 0,
    revision: 1,
    confirmed: true,
  });
  expect((await publishedArticles(db, s.company.id))[0]!.title).toBe(values.title);
  expect(await listCustomerContentCompanies(db, a.actor)).toEqual([{ id: s.company.id, name: s.company.name }]);
  expect(await loadCustomerArticles(db, a.actor, s.company.id)).toHaveLength(1);
  for (const run of [
    () => loadArticleWorkspace(db, a.actor, { companyId: other.company.id, entryId: null }),
    () => loadCustomerArticles(db, a.actor, other.company.id),
    () => saveArticleWorkingCopy(db, clock, a.actor, { companyId: other.company.id, entryId: null }, 0, values),
    () => saveArticle(db, clock, a.actor, { companyId: other.company.id, ...values }),
    () =>
      publishArticle(db, clock, a.actor, {
        companyId: other.company.id,
        entryId: saved.workspace.scope.entryId!,
        expectedRevision: 1,
        expectedPublicationRevision: 0,
        revision: 1,
      }),
  ])
    await expect(run()).rejects.toThrow("利用できません");
  await expect(loadContentAccess(db, a.actor, s.company.id)).rejects.toThrow("運営権限");
  await expect(inviteContentEditor(db, clock, a.actor, other.input)).rejects.toThrow("運営権限");
});
it("会社単位の停止後は開いた画面の保存・掲載・結果再取得を拒否し、掲載済みの記事は残す", async () => {
  const s = await setup(),
    a = await activate(s),
    scope = { companyId: s.company.id, entryId: null };
  await saveArticleWorkingCopy(db, clock, a.actor, scope, 0, {
    slug: "notice",
    title: "見出し",
    body: "本文",
    category: "news",
    baseRevision: "0",
  });
  const request = { kind: "save" as const, requestId: randomUUID(), copyRevision: 1 };
  const r = await submitArticleOperation(db, clock, a.actor, scope, request);
  await publishArticle(db, clock, a.actor, {
    companyId: s.company.id,
    entryId: r.workspace.scope.entryId!,
    expectedRevision: 1,
    expectedPublicationRevision: 0,
    revision: 1,
  });
  await revokeContentEditor(db, clock, s.ops, { companyId: s.company.id, accessId: a.access.id, revision: 2 });
  expect(await listCustomerContentCompanies(db, a.actor)).toEqual([]);
  await expect(loadArticleWorkspace(db, a.actor, r.workspace.scope)).rejects.toThrow("利用できません");
  await expect(submitArticleOperation(db, clock, a.actor, scope, request)).rejects.toThrow("利用できません");
  await expect(
    saveArticleWorkingCopy(db, clock, a.actor, r.workspace.scope, 0, { ...r.workspace.current, body: "停止後" }),
  ).rejects.toThrow("利用できません");
  expect(await publishedArticles(db, s.company.id)).toHaveLength(1);
});
it("既存顧客は同じパスワードで別会社を追加し、一社の停止で別会社まで失わない", async () => {
  const s = await setup(),
    a = await activate(s),
    other = await setup();
  other.input.email = s.input.email;
  const r = await invite(other);
  await expect(
    acceptContentInvitation(db, clock, {
      token: r.token!,
      displayName: "",
      password: "wrong-password-42",
      confirmed: true,
    }),
  ).rejects.toThrow("登録済み");
  const linked = await acceptContentInvitation(db, clock, {
    token: r.token!,
    displayName: "",
    password,
    confirmed: true,
  });
  expect(linked.userId).toBe(a.userId);
  expect(await listCustomerContentCompanies(db, a.actor)).toHaveLength(2);
  await revokeContentEditor(db, clock, s.ops, { companyId: s.company.id, accessId: a.access.id, revision: 2 });
  expect(await listCustomerContentCompanies(db, a.actor)).toEqual([{ id: other.company.id, name: other.company.name }]);
});
it("停止顧客・未完了化した契約・停止運営は利用できず、全社停止でセッションも失効する", async () => {
  const s = await setup(),
    a = await activate(s),
    provider = createLocalAuthProvider({ db, clock });
  const login = await provider.login({ email: s.input.email, password });
  if (!login.ok) throw Error("login");
  expect((await suspendUser(db, clock, s.ops, a.userId)).ok).toBe(true);
  expect(await provider.authenticate(login.value.token)).toMatchObject({ ok: false });
  await expect(loadArticleWorkspace(db, a.actor, { companyId: s.company.id, entryId: null })).rejects.toThrow(
    "顧客アカウント",
  );
  expect(await inspectContentInvitation(db, clock, a.token!)).toBeNull();
  expect((await reactivateUser(db, clock, s.ops, a.userId)).ok).toBe(true);
  await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, s.contract.id));
  await expect(loadArticleWorkspace(db, a.actor, { companyId: s.company.id, entryId: null })).rejects.toThrow(
    "利用契約",
  );
  expect(await inspectContentInvitation(db, clock, a.token!)).toBeNull();
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  await expect(
    revokeContentEditor(db, clock, s.ops, { companyId: s.company.id, accessId: a.access.id, revision: 2 }),
  ).rejects.toThrow("有効な運営");
  expect((await suspendUser(db, clock, s.ops, a.userId)).ok).toBe(false);
});
it("営業や運営のアカウントを顧客に変更せず、別会社の契約や受付番号の流用を拒否する", async () => {
  const s = await setup(),
    other = await setup();
  const [user] = await db.select().from(users).where(eq(users.id, s.sales.userId));
  await expect(inviteContentEditor(db, clock, s.ops, { ...s.input, email: user!.email })).rejects.toThrow(
    "招待できません",
  );
  await expect(inviteContentEditor(db, clock, s.ops, { ...s.input, contractId: other.contract.id })).rejects.toThrow(
    "完了契約",
  );
  await invite(s);
  await expect(inviteContentEditor(db, clock, s.ops, { ...s.input, email: "different@example.test" })).rejects.toThrow(
    "受付番号",
  );
});
it("招待受付の記録が失敗したら顧客アカウントと利用開始を全て巻き戻す", async () => {
  const s = await setup(),
    r = await invite(s);
  await db.execute(
    sql`create function reject_customer_accept() returns trigger language plpgsql as $$ begin raise exception 'qa accept rollback'; end; $$`,
  );
  await db.execute(
    sql`create trigger reject_customer_accept before update on content_access for each row execute function reject_customer_accept()`,
  );
  await expect(
    acceptContentInvitation(db, clock, { token: r.token!, displayName: "顧客", password, confirmed: true }),
  ).rejects.toMatchObject({ cause: { message: "qa accept rollback" } });
  expect(await db.select().from(users).where(eq(users.email, s.input.email))).toHaveLength(0);
  expect((await db.select().from(contentAccess))[0]?.status).toBe("invited");
  expect((await db.select().from(auditEvents)).filter((e) => e.action === "user.customer_registered")).toHaveLength(0);
});
