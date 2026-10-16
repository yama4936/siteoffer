import { randomUUID } from "node:crypto";
import { auditEvents, type Db, passwordRecoveries, sessions, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DAY, fixedClock } from "../common/clock.ts";
import { hashPassword, hashToken, verifyPassword } from "./crypto.ts";
import { createLocalAuthProvider } from "./local-provider.ts";
import {
  cancelPasswordRecovery,
  inspectPasswordRecovery,
  issuePasswordRecovery,
  listPasswordRecoveries,
  requestPasswordRecovery,
  resetRecoveredPassword,
} from "./recovery.ts";
import { changeOwnPassword } from "./security.ts";

let db: Db, close: () => Promise<void>, clock: ReturnType<typeof fixedClock>;
const password = "original-password-for-test",
  nextPassword = "replacement-password-for-test";
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = fixedClock("2026-10-17T00:00:00Z");
});
afterEach(async () => close());
async function account(role: "sales" | "customer" | "ops" = "customer") {
  const [user] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.test`,
      displayName: "検証ユーザー",
      role,
      passwordHash: await hashPassword(password),
    })
    .returning();
  const auth = createLocalAuthProvider({ db, clock }),
    login = await auth.login({ email: user!.email, password });
  if (!login.ok) throw Error(login.error);
  return { user: user!, token: login.value.token, auth };
}
async function fixture(role: "sales" | "customer" = "customer") {
  const target = await account(role),
    ops = await account("ops");
  await requestPasswordRecovery(db, clock, target.user.email);
  const [row] = await db.select().from(passwordRecoveries);
  const input = {
    id: row!.id,
    revision: 1,
    requestId: randomUUID(),
    verificationMethod: "known_contact" as const,
    confirmed: true,
    operatorPassword: password,
  };
  return { target, ops, row: row!, input };
}
async function issued() {
  const f = await fixture();
  return { ...f, result: await issuePasswordRecovery(db, clock, f.ops.token, f.input) };
}
it("匿名申請の返答は同一で、有効な依頼・案内・現在の認証を重複申請で変更しない", async () => {
  const f = await fixture();
  const suspended = await account();
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, suspended.user.id));
  for (const email of [
    "missing@example.test",
    f.ops.user.email,
    suspended.user.email,
    "not-an-email",
    f.target.user.email,
  ])
    expect(await requestPasswordRecovery(db, clock, email)).toBeUndefined();
  expect(await db.select().from(passwordRecoveries)).toHaveLength(1);
  const result = await issuePasswordRecovery(db, clock, f.ops.token, f.input);
  await requestPasswordRecovery(db, clock, f.target.user.email);
  expect(await db.select().from(passwordRecoveries)).toHaveLength(1);
  expect(await inspectPasswordRecovery(db, clock, result.token!)).not.toBeNull();
  expect((await f.target.auth.authenticate(f.target.token)).ok).toBe(true);
  expect((await db.select().from(users).where(eq(users.id, f.target.user.id)))[0]!.credentialRevision).toBe(0);
});
it("運営セッション、再認証、本人確認と最新の依頼版が揃った時だけ発行する", async () => {
  const f = await fixture();
  await expect(listPasswordRecoveries(db, clock, f.target.token)).rejects.toThrow("運営");
  await expect(issuePasswordRecovery(db, clock, f.target.token, f.input)).rejects.toThrow("運営");
  for (const patch of [{ confirmed: false }, { operatorPassword: "wrong-password" }, { revision: 2 }])
    await expect(issuePasswordRecovery(db, clock, f.ops.token, { ...f.input, ...patch })).rejects.toThrow();
  expect((await db.select().from(passwordRecoveries))[0]!.status).toBe("requested");
  const r = await issuePasswordRecovery(db, clock, f.ops.token, f.input);
  expect(r.token).toHaveLength(43);
  const [row] = await db.select().from(passwordRecoveries);
  expect(row!.tokenHash).toBe(hashToken(r.token!));
  for (const data of [
    await db.select().from(passwordRecoveries),
    await db.select().from(auditEvents),
    await listPasswordRecoveries(db, clock, f.ops.token),
  ])
    expect(JSON.stringify(data)).not.toContain(r.token!);
  expect(JSON.stringify(await listPasswordRecoveries(db, clock, f.ops.token))).not.toContain(row!.tokenHash!);
  const replay = await issuePasswordRecovery(db, clock, f.ops.token, f.input);
  expect(replay).toMatchObject({ token: null, replayed: true, item: { revision: 2 } });
  await expect(
    issuePasswordRecovery(db, clock, f.ops.token, { ...f.input, verificationMethod: "in_person" }),
  ).rejects.toThrow("内容が異なります");
});
it("再発行は旧URLを無効にし、古い取消や別の発行は最新の案内を壊さない", async () => {
  const f = await issued();
  const next = await issuePasswordRecovery(db, clock, f.ops.token, {
    ...f.input,
    revision: 2,
    requestId: randomUUID(),
  });
  expect(await inspectPasswordRecovery(db, clock, f.result.token!)).toBeNull();
  expect(await inspectPasswordRecovery(db, clock, next.token!)).not.toBeNull();
  await expect(cancelPasswordRecovery(db, clock, f.ops.token, { id: f.row.id, revision: 2 })).rejects.toThrow(
    "変更されています",
  );
  await expect(issuePasswordRecovery(db, clock, f.ops.token, f.input)).rejects.toThrow("変更されています");
  await expect(
    resetRecoveredPassword(db, clock, { token: f.result.token!, password: nextPassword, confirmation: nextPassword }),
  ).rejects.toThrow("案内");
  expect((await db.select().from(passwordRecoveries))[0]!.revision).toBe(3);
});
it.each(["sales", "customer"] as const)(
  "%sの本人再設定は全セッションを解除し、成功再送は後のログインを消さない",
  async (role) => {
    const f = await fixture(role),
      r = await issuePasswordRecovery(db, clock, f.ops.token, f.input);
    await f.target.auth.login({ email: f.target.user.email, password });
    const input = { token: r.token!, password: nextPassword, confirmation: nextPassword };
    expect(await resetRecoveredPassword(db, clock, input)).toEqual({ replayed: false });
    expect(await db.select().from(sessions).where(eq(sessions.userId, f.target.user.id))).toHaveLength(0);
    expect((await f.target.auth.login({ email: f.target.user.email, password })).ok).toBe(false);
    const fresh = await f.target.auth.login({ email: f.target.user.email, password: nextPassword });
    if (!fresh.ok) throw Error(fresh.error);
    expect(await resetRecoveredPassword(db, clock, input)).toEqual({ replayed: true });
    expect((await f.target.auth.authenticate(fresh.value.token)).ok).toBe(true);
    expect(await inspectPasswordRecovery(db, clock, r.token!)).toBeNull();
    expect((await db.select().from(users).where(eq(users.id, f.target.user.id)))[0]!).toMatchObject({
      role,
      credentialRevision: 1,
    });
    expect(
      await db.select().from(auditEvents).where(eq(auditEvents.action, "password_recovery.consumed")),
    ).toHaveLength(1);
    await expect(
      resetRecoveredPassword(db, clock, { ...input, password: "another-password", confirmation: "another-password" }),
    ).rejects.toThrow("案内");
    await changeOwnPassword(db, clock, fresh.value.token, {
      currentPassword: nextPassword,
      newPassword: "later-new-password",
      confirmation: "later-new-password",
      expectedRevision: 1,
    });
    await expect(resetRecoveredPassword(db, clock, input)).rejects.toThrow("案内");
  },
);
it("30分の期限、取消、停止、依頼後の自己変更で案内を利用できなくなる", async () => {
  const f = await issued();
  const input = { token: f.result.token!, password: nextPassword, confirmation: nextPassword };
  clock.advance(30 * 60 * 1000);
  expect(await inspectPasswordRecovery(db, clock, input.token)).toBeNull();
  await expect(resetRecoveredPassword(db, clock, input)).rejects.toThrow("案内");
  const reissued = await issuePasswordRecovery(db, clock, f.ops.token, {
    ...f.input,
    revision: 2,
    requestId: randomUUID(),
  });
  input.token = reissued.token!;
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, f.target.user.id));
  await expect(resetRecoveredPassword(db, clock, input)).rejects.toThrow("案内");
  await db.update(users).set({ status: "active" }).where(eq(users.id, f.target.user.id));
  await changeOwnPassword(db, clock, f.target.token, {
    currentPassword: password,
    newPassword: nextPassword,
    confirmation: nextPassword,
    expectedRevision: 0,
  });
  await expect(resetRecoveredPassword(db, clock, input)).rejects.toThrow("案内");
  await cancelPasswordRecovery(db, clock, f.ops.token, { id: f.row.id, revision: 3 });
  await cancelPasswordRecovery(db, clock, f.ops.token, { id: f.row.id, revision: 3 });
  expect((await db.select().from(passwordRecoveries))[0]!.status).toBe("cancelled");
  expect((await f.target.auth.login({ email: f.target.user.email, password: nextPassword })).ok).toBe(true);
});
it("期限切れの再依頼は履歴を残して新規受付にし、7日を越えた受付からは発行しない", async () => {
  const f = await issued();
  clock.advance(30 * 60 * 1000);
  await requestPasswordRecovery(db, clock, f.target.user.email);
  const rows = await db.select().from(passwordRecoveries);
  expect(rows.map((r) => r.status).sort()).toEqual(["expired", "requested"]);
  const open = rows.find((r) => r.status === "requested")!;
  clock.advance(7 * DAY);
  const login = await f.ops.auth.login({ email: f.ops.user.email, password });
  if (!login.ok) throw Error(login.error);
  await expect(
    issuePasswordRecovery(db, clock, login.value.token, {
      ...f.input,
      id: open.id,
      revision: 1,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow("終了しています");
  await requestPasswordRecovery(db, clock, f.target.user.email);
  expect(await db.select().from(passwordRecoveries)).toHaveLength(3);
});
it("停止・ログアウトした運営は古い画面から発行・取消・一覧取得できない", async () => {
  const f = await fixture();
  await f.ops.auth.logout(f.ops.token);
  await expect(issuePasswordRecovery(db, clock, f.ops.token, f.input)).rejects.toThrow("ログイン");
  await expect(cancelPasswordRecovery(db, clock, f.ops.token, { id: f.row.id, revision: 1 })).rejects.toThrow(
    "ログイン",
  );
  await expect(listPasswordRecoveries(db, clock, f.ops.token)).rejects.toThrow("ログイン");
  const login = await f.ops.auth.login({ email: f.ops.user.email, password });
  if (!login.ok) throw Error(login.error);
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, f.ops.user.id));
  await expect(issuePasswordRecovery(db, clock, login.value.token, f.input)).rejects.toThrow("運営");
});
it("復旧依頼を流用して運営のパスワードや役割を変更できない", async () => {
  const f = await issued();
  await db.update(users).set({ role: "ops" }).where(eq(users.id, f.target.user.id));
  expect(await inspectPasswordRecovery(db, clock, f.result.token!)).toBeNull();
  await expect(
    resetRecoveredPassword(db, clock, { token: f.result.token!, password: nextPassword, confirmation: nextPassword }),
  ).rejects.toThrow("案内");
  await expect(
    issuePasswordRecovery(db, clock, f.ops.token, { ...f.input, revision: 2, requestId: randomUUID() }),
  ).rejects.toThrow("運営");
  await expect(cancelPasswordRecovery(db, clock, f.ops.token, { id: f.row.id, revision: 2 })).rejects.toThrow("運営");
});
it("監査が失敗したらパスワード・案内消費・セッション解除を全て戻す", async () => {
  const f = await issued();
  await db.execute(
    sql`CREATE FUNCTION reject_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'password_recovery.consumed' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_recovery_audit()`,
  );
  await expect(
    resetRecoveredPassword(db, clock, { token: f.result.token!, password: nextPassword, confirmation: nextPassword }),
  ).rejects.toThrow();
  const [stored] = await db.select().from(users).where(eq(users.id, f.target.user.id));
  expect(stored!.credentialRevision).toBe(0);
  expect(await verifyPassword(password, stored!.passwordHash)).toBe(true);
  expect((await f.target.auth.authenticate(f.target.token)).ok).toBe(true);
  expect((await db.select().from(passwordRecoveries))[0]!.status).toBe("issued");
});
it("運営の再認証失敗はログインと同じ枠を消費し、復旧URLの試行は別に制限する", async () => {
  const f = await issued();
  for (let i = 0; i < 5; i++)
    await expect(
      issuePasswordRecovery(db, clock, f.ops.token, { ...f.input, operatorPassword: "wrong-password" }),
    ).rejects.toThrow("パスワード");
  expect(await f.ops.auth.login({ email: f.ops.user.email, password })).toMatchObject({ error: "rate_limited" });
  const input = { token: f.result.token!, password: nextPassword, confirmation: nextPassword };
  await resetRecoveredPassword(db, clock, input);
  for (let i = 0; i < 4; i++)
    await expect(
      resetRecoveredPassword(db, clock, {
        ...input,
        password: "wrong-new-password",
        confirmation: "wrong-new-password",
      }),
    ).rejects.toThrow("案内");
  await expect(resetRecoveredPassword(db, clock, input)).rejects.toThrow("上限");
  expect((await f.target.auth.login({ email: f.target.user.email, password: nextPassword })).ok).toBe(true);
});
it("一覧は20件ずつ取得し、終了した依頼を未完了と区別する", async () => {
  const ops = await account("ops");
  const people = await db
    .insert(users)
    .values(
      Array.from({ length: 22 }, (_, i) => ({
        email: `page-${i}@example.test`,
        displayName: `顧客${i}`,
        role: "customer" as const,
        passwordHash: "test-not-used",
      })),
    )
    .returning();
  await db.insert(passwordRecoveries).values(
    people.map((u, i) => ({
      userId: u.id,
      credentialRevision: 0,
      requestedAt: new Date(clock.now().getTime() + i),
      status: i === 21 ? ("cancelled" as const) : ("requested" as const),
    })),
  );
  const first = await listPasswordRecoveries(db, clock, ops.token),
    second = await listPasswordRecoveries(db, clock, ops.token, { page: 1 }),
    history = await listPasswordRecoveries(db, clock, ops.token, { history: true });
  expect(first.total).toBe(21);
  expect(first.items).toHaveLength(20);
  expect(second.items).toHaveLength(1);
  expect(history.total).toBe(1);
  expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(21);
});

it("受付7日の直前に発行した案内も30分間有効で、匿名の再依頼では壊れない", async () => {
  const f = await fixture();
  clock.advance(7 * DAY - 10 * 60 * 1000);
  const login = await f.ops.auth.login({ email: f.ops.user.email, password });
  if (!login.ok) throw Error(login.error);
  const r = await issuePasswordRecovery(db, clock, login.value.token, f.input);
  clock.advance(15 * 60 * 1000);
  await requestPasswordRecovery(db, clock, f.target.user.email);
  expect(await db.select().from(passwordRecoveries)).toHaveLength(1);
  expect(await inspectPasswordRecovery(db, clock, r.token!)).not.toBeNull();
  expect(
    await resetRecoveredPassword(db, clock, { token: r.token!, password: nextPassword, confirmation: nextPassword }),
  ).toEqual({ replayed: false });
});
