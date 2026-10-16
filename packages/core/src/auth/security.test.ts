import { auditEvents, authAttempts, type Db, sessions, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DAY, fixedClock } from "../common/clock.ts";
import {
  AUTH_ATTEMPT_WINDOW_MS,
  authAttemptKey,
  claimAuthAttempt,
  cleanupAuthAttempts,
  clearAuthAttempts,
} from "./attempts.ts";
import { hashPassword, verifyPassword } from "./crypto.ts";
import { createLocalAuthProvider } from "./local-provider.ts";
import { changeOwnPassword, loadAccountSecurity } from "./security.ts";

let db: Db, close: () => Promise<void>;
let clock: ReturnType<typeof fixedClock>;
const oldPassword = "test-original-password",
  newPassword = "test-replacement-password";
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = fixedClock("2026-10-17T00:00:00Z");
});
afterEach(async () => {
  await close();
});
async function fixture(role: "ops" | "sales" | "customer" = "customer") {
  const [user] = await db
    .insert(users)
    .values({
      email: `${role}@example.test`,
      displayName: "検証用",
      role,
      passwordHash: await hashPassword(oldPassword),
      createdAt: clock.now(),
      updatedAt: clock.now(),
    })
    .returning();
  const auth = createLocalAuthProvider({ db, clock });
  const login = await auth.login({ email: user!.email, password: oldPassword });
  if (!login.ok) throw new Error(login.error);
  return { user: user!, auth, token: login.value.token };
}
const input = { currentPassword: oldPassword, newPassword, confirmation: newPassword, expectedRevision: 0 };
it.each(["sales", "ops", "customer"] as const)(
  "%s changes own password, revokes every old login, preserves role and audits no credentials",
  async (role) => {
    const { user, auth, token } = await fixture(role);
    const second = await auth.login({ email: user.email, password: oldPassword });
    expect(second.ok).toBe(true);
    expect(await loadAccountSecurity(db, clock, token)).toEqual({
      email: user.email,
      credentialRevision: 0,
      activeLogins: 2,
    });
    await changeOwnPassword(db, clock, token, input);
    expect(await db.select().from(sessions)).toHaveLength(0);
    expect((await auth.authenticate(token)).ok).toBe(false);
    if (second.ok) expect((await auth.authenticate(second.value.token)).ok).toBe(false);
    expect((await auth.login({ email: user.email, password: oldPassword })).ok).toBe(false);
    expect((await auth.login({ email: user.email, password: newPassword })).ok).toBe(true);
    const [stored] = await db.select().from(users).where(eq(users.id, user.id));
    expect(stored).toMatchObject({ role, status: "active", credentialRevision: 1 });
    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "user.password_changed"));
    expect(events).toHaveLength(1);
    expect(events[0]!.after).toEqual({ credentialRevision: 1, revokedLogins: 2 });
    for (const secret of [oldPassword, newPassword, stored!.passwordHash, token])
      expect(JSON.stringify(events)).not.toContain(secret);
  },
);
it("wrong current password consumes budget but changes neither credentials nor sessions", async () => {
  const { auth, user, token } = await fixture();
  await expect(changeOwnPassword(db, clock, token, { ...input, currentPassword: "wrong-password" })).rejects.toThrow(
    "現在のパスワード",
  );
  expect((await auth.authenticate(token)).ok).toBe(true);
  expect((await db.select().from(users))[0]!.credentialRevision).toBe(0);
  expect((await db.select().from(authAttempts))[0]!.attempts).toBe(1);
  for (let i = 0; i < 4; i++) await auth.login({ email: user.email, password: "wrong-password" });
  await expect(changeOwnPassword(db, clock, token, input)).rejects.toThrow("上限");
  clock.advance(AUTH_ATTEMPT_WINDOW_MS);
  await changeOwnPassword(db, clock, token, input);
});
it("rejects invalid, expired, logged-out, and suspended sessions without changing password", async () => {
  const { auth, user, token } = await fixture();
  await expect(changeOwnPassword(db, clock, "invalid", input)).rejects.toThrow("ログイン");
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
  await expect(changeOwnPassword(db, clock, token, input)).rejects.toThrow("ログイン");
  await db.update(users).set({ status: "active" }).where(eq(users.id, user.id));
  clock.advance(100 * DAY);
  await expect(changeOwnPassword(db, clock, token, input)).rejects.toThrow("ログイン");
  const next = await auth.login({ email: user.email, password: oldPassword });
  if (!next.ok) throw new Error(next.error);
  await auth.logout(next.value.token);
  await expect(changeOwnPassword(db, clock, next.value.token, input)).rejects.toThrow("ログイン");
  expect((await db.select().from(users))[0]!.credentialRevision).toBe(0);
});
it("old form and lost-response retries cannot overwrite a later password or invalidate new logins", async () => {
  const { auth, user, token } = await fixture();
  await expect(changeOwnPassword(db, clock, token, { ...input, expectedRevision: 3 })).rejects.toThrow(
    "変更されています",
  );
  await changeOwnPassword(db, clock, token, input);
  const next = await auth.login({ email: user.email, password: newPassword });
  if (!next.ok) throw new Error(next.error);
  await expect(changeOwnPassword(db, clock, token, input)).rejects.toThrow("ログイン");
  expect((await auth.authenticate(next.value.token)).ok).toBe(true);
  expect((await db.select().from(users))[0]!.credentialRevision).toBe(1);
});
it("validates confirmation, length, changed value, and revision before mutation", async () => {
  const { token } = await fixture();
  for (const patch of [
    { confirmation: "mismatch" },
    { newPassword: "short" },
    { newPassword: "x".repeat(201) },
    { newPassword: oldPassword, confirmation: oldPassword },
    { expectedRevision: -1 },
    { expectedRevision: NaN },
  ]) {
    await expect(changeOwnPassword(db, clock, token, { ...input, ...patch })).rejects.toThrow();
  }
  expect((await db.select().from(users))[0]!.credentialRevision).toBe(0);
  expect(await db.select().from(authAttempts)).toHaveLength(0);
});
it("rolls back password and session removal if audit insertion fails", async () => {
  const { token } = await fixture();
  await db.execute(
    `CREATE FUNCTION reject_security_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'user.password_changed' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    `CREATE TRIGGER reject_security_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_security_audit()`,
  );
  await expect(changeOwnPassword(db, clock, token, input)).rejects.toThrow();
  const [stored] = await db.select().from(users);
  expect(await verifyPassword(oldPassword, stored!.passwordHash)).toBe(true);
  expect(stored!.credentialRevision).toBe(0);
  expect(await db.select().from(sessions)).toHaveLength(1);
  expect((await db.select().from(authAttempts))[0]!.attempts).toBe(1);
});
it("limits existing and unknown email attempts identically, normalizes case, and uses a fixed window", async () => {
  const { auth, user } = await fixture();
  for (const email of [user.email, "missing@example.test"]) {
    for (let i = 0; i < 5; i++)
      expect(await auth.login({ email: ` ${email.toUpperCase()} `, password: "wrong" })).toMatchObject({
        ok: false,
        error: "invalid_credentials",
      });
    expect(await auth.login({ email, password: oldPassword })).toMatchObject({ ok: false, error: "rate_limited" });
  }
  clock.advance(AUTH_ATTEMPT_WINDOW_MS - 1);
  expect(await auth.login({ email: user.email, password: oldPassword })).toMatchObject({ error: "rate_limited" });
  clock.advance(1);
  expect((await auth.login({ email: user.email, password: oldPassword })).ok).toBe(true);
  expect(
    await db
      .select()
      .from(authAttempts)
      .where(eq(authAttempts.key, authAttemptKey("credential", user.email))),
  ).toHaveLength(0);
});
it("parallel reservations admit five, deletion races do not crash, and maintenance preserves recent identities", async () => {
  const key = authAttemptKey("credential", "a@example.test");
  expect(
    (await Promise.all(Array.from({ length: 12 }, () => claimAuthAttempt(db, clock, key)))).filter(Boolean),
  ).toHaveLength(5);
  await Promise.all([
    clearAuthAttempts(db, key),
    claimAuthAttempt(db, clock, key),
    clearAuthAttempts(db, key),
    claimAuthAttempt(db, clock, key),
  ]);
  clock.advance(2 * DAY);
  const recent = authAttemptKey("credential", "b@example.test");
  await claimAuthAttempt(db, clock, recent);
  await cleanupAuthAttempts(db, clock);
  expect((await db.select().from(authAttempts)).map((row) => row.key)).toEqual([recent]);
});
