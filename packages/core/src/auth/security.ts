import { type Db, type DbOrTx, sessions, users } from "@siteoffer/db";
import { and, count, eq, gt } from "drizzle-orm";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { authAttemptKey, claimAuthAttempt, clearAuthAttempts } from "./attempts.ts";
import { hashPassword, hashToken, verifyPassword } from "./crypto.ts";
import { validatePassword } from "./validation.ts";

export class AccountSecurityError extends Error {}
const sessionError = () =>
  new AccountSecurityError("ログインの有効期限が切れたか、解除されています。もう一度ログインしてください");
export async function sessionUserId(db: DbOrTx, clock: Clock, token: string) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw sessionError();
  const [session] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, clock.now())));
  if (!session) throw sessionError();
  return session.userId;
}
export async function requireLiveSession(db: DbOrTx, clock: Clock, token: string, userId: string) {
  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(eq(sessions.tokenHash, hashToken(token)), eq(sessions.userId, userId), gt(sessions.expiresAt, clock.now())),
    )
    .for("share");
  if (!session) throw sessionError();
}
export async function loadAccountSecurity(db: Db, clock: Clock, token: string) {
  const userId = await sessionUserId(db, clock, token);
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("share");
    if (user?.status !== "active") throw sessionError();
    await requireLiveSession(tx, clock, token, userId);
    const [total] = await tx
      .select({ value: count() })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, clock.now())));
    return { email: user.email, credentialRevision: user.credentialRevision, activeLogins: total!.value };
  });
}
/** Session token is server-side only; no user ID supplied by the browser is trusted. */
export async function changeOwnPassword(
  db: Db,
  clock: Clock,
  token: string,
  input: {
    currentPassword: string;
    newPassword: string;
    confirmation: string;
    expectedRevision: number;
  },
) {
  if (
    !input ||
    typeof input.currentPassword !== "string" ||
    input.currentPassword.length > 200 ||
    typeof input.newPassword !== "string" ||
    typeof input.confirmation !== "string" ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    throw new AccountSecurityError("入力内容を確認してください");
  const invalid = validatePassword(input.newPassword);
  if (invalid) throw new AccountSecurityError(invalid);
  if (input.newPassword !== input.confirmation) throw new AccountSecurityError("新しいパスワードが一致しません");
  if (input.newPassword === input.currentPassword)
    throw new AccountSecurityError("現在とは異なるパスワードを設定してください");
  const userId = await sessionUserId(db, clock, token);
  const [hint] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!hint) throw sessionError();
  const key = authAttemptKey("credential", hint.email);
  if (!(await claimAuthAttempt(db, clock, key)))
    throw new AccountSecurityError("試行回数の上限に達しました。15分ほど待ってからお試しください");
  await db.transaction(async (tx) => {
    // Serialize login creation, suspension, and password changes on the user row.
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (user?.status !== "active") throw sessionError();
    await requireLiveSession(tx, clock, token, userId);
    if (user.credentialRevision !== input.expectedRevision)
      throw new AccountSecurityError("パスワードが変更されています。もう一度ログインしてください");
    if (!(await verifyPassword(input.currentPassword, user.passwordHash)))
      throw new AccountSecurityError("現在のパスワードを確認してください");
    await tx
      .update(users)
      .set({
        passwordHash: await hashPassword(input.newPassword),
        credentialRevision: user.credentialRevision + 1,
        updatedAt: clock.now(),
      })
      .where(eq(users.id, userId));
    const removed = await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
    await recordEvent(tx, clock, {
      actor: { kind: user.role === "customer" ? "customer_user" : user.role, userId },
      action: "user.password_changed",
      targetType: "user",
      targetId: userId,
      after: { credentialRevision: user.credentialRevision + 1, revokedLogins: removed.length },
    });
  });
  await clearAuthAttempts(db, key);
}
