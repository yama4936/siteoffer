import { auditEvents, type Db, sessions, termsAcceptances, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAY, fixedClock, HOUR } from "../common/clock.ts";
import { hashPassword, verifyPassword } from "./crypto.ts";
import { createLocalAuthProvider } from "./local-provider.ts";
import type { AuthProvider } from "./provider.ts";
import { seedDevUsers } from "./seed.ts";
import { ensureTermsVersion, PLACEHOLDER_TERMS } from "./terms.ts";
import { createUserBySystem, reactivateUser, suspendUser } from "./users.ts";

let db: Db;
let close: () => Promise<void>;
let clock: ReturnType<typeof fixedClock>;
let auth: AuthProvider;
const PASSWORD = "test-password-123";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = fixedClock("2026-10-14T00:00:00Z");
  auth = createLocalAuthProvider({ db, clock });
});
afterEach(async () => {
  await close();
});

async function registerSales(email = "a@example.test") {
  const terms = await ensureTermsVersion(db, clock, PLACEHOLDER_TERMS);
  const r = await auth.registerSales({
    email,
    password: PASSWORD,
    displayName: "営業A",
    acceptedTermsVersionId: terms.id,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value.userId;
}

async function createOps() {
  const r = await createUserBySystem(db, clock, {
    email: "ops@example.test",
    password: PASSWORD,
    displayName: "運営",
    role: "ops",
    job: "test",
  });
  if (!r.ok) throw new Error(r.error);
  return { kind: "ops" as const, userId: r.value.userId };
}

describe("パスワードのハッシュ", () => {
  it("平文を保存せず、正しいパスワードだけ一致する", async () => {
    const h = await hashPassword(PASSWORD);
    expect(h).not.toContain(PASSWORD);
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword(PASSWORD, h)).toBe(true);
    expect(await verifyPassword("wrong-password", h)).toBe(false);
    expect(await verifyPassword(PASSWORD, "garbage")).toBe(false);
  });
});

describe("営業ユーザーの自己登録（F-30）", () => {
  it("最新の利用条件に同意すると登録でき、同意が記録される", async () => {
    const terms = await ensureTermsVersion(db, clock, PLACEHOLDER_TERMS);
    const r = await auth.registerSales({
      email: " A@Example.TEST ",
      password: PASSWORD,
      displayName: "営業A",
      acceptedTermsVersionId: terms.id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [u] = await db.select().from(users).where(eq(users.id, r.value.userId));
    expect(u).toMatchObject({ email: "a@example.test", role: "sales", status: "active" });
    expect(u!.passwordHash).not.toContain(PASSWORD);
    const acc = await db.select().from(termsAcceptances).where(eq(termsAcceptances.userId, r.value.userId));
    expect(acc).toHaveLength(1);
    expect(acc[0]!.termsVersionId).toBe(terms.id);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.actorId, r.value.userId));
    expect(events.map((e) => e.action).sort()).toEqual(["terms.accepted", "user.registered"]);
  });

  it("利用条件に同意しないと登録できない", async () => {
    await ensureTermsVersion(db, clock, PLACEHOLDER_TERMS);
    const r = await auth.registerSales({
      email: "a@example.test",
      password: PASSWORD,
      displayName: "営業A",
      acceptedTermsVersionId: null,
    });
    expect(r).toMatchObject({ ok: false, error: "terms_not_accepted" });
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("古い版への同意では登録できない", async () => {
    const old = await ensureTermsVersion(db, clock, PLACEHOLDER_TERMS);
    clock.advance(DAY);
    await ensureTermsVersion(db, clock, { version: "draft-1", body: "【仮の文面】改定版" });
    const r = await auth.registerSales({
      email: "a@example.test",
      password: PASSWORD,
      displayName: "営業A",
      acceptedTermsVersionId: old.id,
    });
    expect(r).toMatchObject({ ok: false, error: "terms_outdated" });
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("利用条件が未登録なら登録できない", async () => {
    const r = await auth.registerSales({
      email: "a@example.test",
      password: PASSWORD,
      displayName: "営業A",
      acceptedTermsVersionId: "00000000-0000-4000-8000-000000000000",
    });
    expect(r).toMatchObject({ ok: false, error: "terms_unavailable" });
  });

  it("同じメールでは二重に登録できない（大文字小文字を区別しない）", async () => {
    await registerSales("a@example.test");
    const terms = await ensureTermsVersion(db, clock, PLACEHOLDER_TERMS);
    const r = await auth.registerSales({
      email: "A@example.test",
      password: PASSWORD,
      displayName: "別人",
      acceptedTermsVersionId: terms.id,
    });
    expect(r).toMatchObject({ ok: false, error: "email_taken" });
  });

  it("短いパスワード・不正なメールを拒否する", async () => {
    const terms = await ensureTermsVersion(db, clock, PLACEHOLDER_TERMS);
    const base = { displayName: "営業A", acceptedTermsVersionId: terms.id };
    expect(await auth.registerSales({ ...base, email: "a@example.test", password: "short" })).toMatchObject({
      ok: false,
      error: "weak_password",
    });
    expect(await auth.registerSales({ ...base, email: "not-an-email", password: PASSWORD })).toMatchObject({
      ok: false,
      error: "invalid_email",
    });
  });

  it("自己登録の経路では営業ユーザーしか作られない（運営は自己登録できない）", async () => {
    const userId = await registerSales();
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u!.role).toBe("sales");
  });
});

describe("ログインとセッション", () => {
  it("ログインするとセッションができ、トークンはハッシュで保存される", async () => {
    const userId = await registerSales();
    const r = await auth.login({ email: "a@example.test", password: PASSWORD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.user.actor).toEqual({ kind: "sales", userId });
    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(r.value.token);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const a = await auth.authenticate(r.value.token);
    expect(a).toMatchObject({ ok: true, value: { actor: { kind: "sales", userId } } });
  });

  it("運営ユーザーは ops の Actor になる", async () => {
    const opsActor = await createOps();
    const r = await auth.login({ email: "ops@example.test", password: PASSWORD });
    expect(r.ok && r.value.user.actor).toEqual(opsActor);
  });

  it("パスワード違い・存在しないメールは同じ理由で拒否する", async () => {
    await registerSales();
    expect(await auth.login({ email: "a@example.test", password: "wrong-password" })).toMatchObject({
      ok: false,
      error: "invalid_credentials",
    });
    expect(await auth.login({ email: "nobody@example.test", password: PASSWORD })).toMatchObject({
      ok: false,
      error: "invalid_credentials",
    });
  });

  it("期限切れのセッションは無効（既定は運営設定の7日）", async () => {
    await registerSales();
    const r = await auth.login({ email: "a@example.test", password: PASSWORD });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.expiresAt.toISOString()).toBe("2026-10-21T00:00:00.000Z");
    clock.advance(7 * DAY - 1);
    expect((await auth.authenticate(r.value.token)).ok).toBe(true);
    clock.advance(1);
    expect(await auth.authenticate(r.value.token)).toMatchObject({ ok: false, error: "session_expired" });
  });

  it("有効期限を指定できる", async () => {
    auth = createLocalAuthProvider({ db, clock, sessionTtlMs: HOUR });
    await registerSales();
    const r = await auth.login({ email: "a@example.test", password: PASSWORD });
    if (!r.ok) throw new Error(r.error);
    clock.advance(HOUR);
    expect(await auth.authenticate(r.value.token)).toMatchObject({ ok: false, error: "session_expired" });
  });

  it("不明なトークン・空のトークンは無効", async () => {
    expect(await auth.authenticate("unknown")).toMatchObject({ ok: false, error: "invalid_session" });
    expect(await auth.authenticate("")).toMatchObject({ ok: false, error: "invalid_session" });
  });

  it("ログアウトでセッションが消え、以後は無効", async () => {
    await registerSales();
    const r = await auth.login({ email: "a@example.test", password: PASSWORD });
    if (!r.ok) throw new Error(r.error);
    await auth.logout(r.value.token);
    expect(await db.select().from(sessions)).toHaveLength(0);
    expect(await auth.authenticate(r.value.token)).toMatchObject({ ok: false, error: "invalid_session" });
  });
});

describe("利用停止", () => {
  it("停止された営業ユーザーは既存セッションでも操作できず、ログインもできない", async () => {
    const opsActor = await createOps();
    const userId = await registerSales();
    const r = await auth.login({ email: "a@example.test", password: PASSWORD });
    if (!r.ok) throw new Error(r.error);

    expect(await suspendUser(db, clock, opsActor, userId, "テスト")).toEqual({ ok: true, value: undefined });
    expect(await auth.authenticate(r.value.token)).toMatchObject({ ok: false });
    expect(await auth.login({ email: "a@example.test", password: PASSWORD })).toMatchObject({
      ok: false,
      error: "suspended",
    });
    const [ev] = await db.select().from(auditEvents).where(eq(auditEvents.action, "user.suspended"));
    expect(ev).toMatchObject({ actorId: opsActor.userId, targetId: userId });

    expect((await reactivateUser(db, clock, opsActor, userId)).ok).toBe(true);
    expect((await auth.login({ email: "a@example.test", password: PASSWORD })).ok).toBe(true);
  });

  it("セッションが残っていても、停止中は authenticate が suspended を返す", async () => {
    const userId = await registerSales();
    const r = await auth.login({ email: "a@example.test", password: PASSWORD });
    if (!r.ok) throw new Error(r.error);
    // セッション削除を経ない状態変更（DBを直接変更した場合など）でも拒否されること
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, userId));
    expect(await auth.authenticate(r.value.token)).toMatchObject({ ok: false, error: "suspended" });
  });

  it("営業は他の営業を停止できない。運営は運営を停止できない。未ログインも不可", async () => {
    const opsActor = await createOps();
    const a = await registerSales("a@example.test");
    const b = await registerSales("b@example.test");
    expect(await suspendUser(db, clock, { kind: "sales", userId: a }, b)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await suspendUser(db, clock, opsActor, opsActor.userId)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await suspendUser(db, clock, null, b)).toMatchObject({ ok: false, error: "unauthenticated" });
    const [ub] = await db.select().from(users).where(eq(users.id, b));
    expect(ub!.status).toBe("active");
  });

  it("二重の停止は already_in_state", async () => {
    const opsActor = await createOps();
    const userId = await registerSales();
    await suspendUser(db, clock, opsActor, userId);
    expect(await suspendUser(db, clock, opsActor, userId)).toMatchObject({ ok: false, error: "already_in_state" });
  });
});

describe("開発用seed", () => {
  it("運営・営業ユーザーと仮の利用条件を作り、再実行でパスワードを変えない", async () => {
    const first = await seedDevUsers(db, clock);
    expect(first.map((u) => u.role)).toEqual(["ops", "sales"]);
    for (const u of first) {
      expect(u.password).toBeTruthy();
      const r = await auth.login({ email: u.email, password: u.password! });
      expect(r.ok && r.value.user.role).toBe(u.role);
    }
    const second = await seedDevUsers(db, clock);
    expect(second.every((u) => u.password === null)).toBe(true);
    expect(await db.select().from(users)).toHaveLength(2);
  });
});
