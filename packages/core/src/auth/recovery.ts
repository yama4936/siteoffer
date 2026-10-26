import { type Db, type DbOrTx, passwordRecoveries, sessions, users } from "@siteoffer/db";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { authAttemptKey, claimAuthAttempt, clearAuthAttempts } from "./attempts.ts";
import { generateToken, hashPassword, hashToken, verifyPassword } from "./crypto.ts";
import { AccountSecurityError, requireLiveSession, sessionUserId } from "./security.ts";
import { normalizeEmail, validateEmail, validatePassword } from "./validation.ts";

const REQUEST_LIFETIME = 7 * 24 * 60 * 60 * 1000,
  LINK_LIFETIME = 30 * 60 * 1000;
const tokenValid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const uuidValid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const invalidLink = () =>
  new AccountSecurityError("この案内は期限切れ、使用済み、または取り消されています。運営に再発行を依頼してください");
type Recovery = typeof passwordRecoveries.$inferSelect;
function requestAlive(row: Recovery, clock: Clock, revision: number) {
  return row.credentialRevision === revision && row.requestedAt.getTime() + REQUEST_LIFETIME > clock.now().getTime();
}
/** Public acknowledgement is deliberately independent of account existence and eligibility. */
export async function requestPasswordRecovery(db: Db, clock: Clock, rawEmail: unknown): Promise<void> {
  if (typeof rawEmail !== "string" || rawEmail.length > 254) return;
  const email = normalizeEmail(rawEmail);
  if (!validateEmail(email)) return;
  if (!(await claimAuthAttempt(db, clock, authAttemptKey("recovery_request", email)))) return;
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.email, email)).for("update");
    if (user?.status !== "active" || user.role === "ops") return;
    const [open] = await tx
      .select()
      .from(passwordRecoveries)
      .where(and(eq(passwordRecoveries.userId, user.id), inArray(passwordRecoveries.status, ["requested", "issued"])))
      .for("update");
    if (open) {
      if (
        open.credentialRevision === user.credentialRevision &&
        (open.status === "requested"
          ? requestAlive(open, clock, user.credentialRevision)
          : open.expiresAt && open.expiresAt > clock.now())
      )
        return;
      await tx
        .update(passwordRecoveries)
        .set({ status: "expired", revision: open.revision + 1 })
        .where(eq(passwordRecoveries.id, open.id));
    }
    const [created] = await tx
      .insert(passwordRecoveries)
      .values({ userId: user.id, credentialRevision: user.credentialRevision, requestedAt: clock.now() })
      .returning({ id: passwordRecoveries.id });
    await recordEvent(tx, clock, {
      actor: { kind: "system", job: "public-password-recovery-request" },
      action: "password_recovery.requested",
      targetType: "password_recovery",
      targetId: created!.id,
      after: { userId: user.id },
    });
  });
}
async function operator(db: DbOrTx, clock: Clock, token: string, id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id)).for("share");
  if (user?.role !== "ops" || user.status !== "active")
    throw new AccountSecurityError("有効な運営アカウントが必要です");
  await requireLiveSession(db, clock, token, id);
  return user;
}
function view(
  row: Recovery,
  user: { email: string; displayName: string; role: string; status: string; credentialRevision: number },
  clock: Clock,
) {
  const available =
    user.status === "active" && user.role !== "ops" && requestAlive(row, clock, user.credentialRevision);
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    requestedAt: row.requestedAt.toISOString(),
    issuedAt: row.issuedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    consumedAt: row.consumedAt?.toISOString() ?? null,
    verificationMethod: row.verificationMethod,
    canIssue: available && (row.status === "requested" || row.status === "issued"),
    unavailableReason: !["requested", "issued"].includes(row.status)
      ? null
      : user.status !== "active"
        ? "アカウント停止中"
        : !requestAlive(row, clock, user.credentialRevision)
          ? "依頼後にパスワードが変更されたか、受付から7日を過ぎています"
          : null,
    linkExpired: row.status === "issued" && (!row.expiresAt || row.expiresAt <= clock.now()),
  };
}
export type RecoveryView = ReturnType<typeof view>;
export async function listPasswordRecoveries(
  db: Db,
  clock: Clock,
  token: string,
  input: { page?: number; history?: boolean } = {},
) {
  const operatorId = await sessionUserId(db, clock, token),
    page = Number.isSafeInteger(input.page) && input.page! >= 0 ? Math.min(input.page!, 100000) : 0;
  return db.transaction(async (tx) => {
    await operator(tx, clock, token, operatorId);
    const filter = inArray(
      passwordRecoveries.status,
      input.history ? ["consumed", "cancelled", "expired"] : ["requested", "issued"],
    );
    const [total] = await tx.select({ value: count() }).from(passwordRecoveries).where(filter);
    const rows = await tx
      .select({ recovery: passwordRecoveries, user: users })
      .from(passwordRecoveries)
      .innerJoin(users, eq(users.id, passwordRecoveries.userId))
      .where(filter)
      .orderBy(desc(passwordRecoveries.requestedAt), desc(passwordRecoveries.id))
      .limit(20)
      .offset(page * 20);
    return { total: total!.value, page, items: rows.map((r) => view(r.recovery, r.user, clock)) };
  });
}
export interface IssueRecoveryInput {
  id: string;
  revision: number;
  requestId: string;
  verificationMethod: "known_contact" | "in_person";
  confirmed: boolean;
  operatorPassword: string;
}
export async function issuePasswordRecovery(db: Db, clock: Clock, token: string, input: IssueRecoveryInput) {
  if (
    !input ||
    !uuidValid(input.id) ||
    !uuidValid(input.requestId) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.confirmed !== true ||
    !["known_contact", "in_person"].includes(input.verificationMethod) ||
    typeof input.operatorPassword !== "string" ||
    input.operatorPassword.length > 200
  )
    throw new AccountSecurityError("本人確認の方法、確認チェック、運営のパスワードを確認してください");
  const operatorId = await sessionUserId(db, clock, token);
  const [who] = await db.select({ email: users.email }).from(users).where(eq(users.id, operatorId));
  if (!who) throw new AccountSecurityError("ログインしてください");
  const key = authAttemptKey("credential", who.email);
  if (!(await claimAuthAttempt(db, clock, key)))
    throw new AccountSecurityError("試行回数の上限に達しました。15分ほど待ってからお試しください");
  const result = await db.transaction(async (tx) => {
    const ops = await operator(tx, clock, token, operatorId);
    if (!(await verifyPassword(input.operatorPassword, ops.passwordHash)))
      throw new AccountSecurityError("運営アカウントの現在のパスワードを確認してください");
    const [hint] = await tx
      .select({ userId: passwordRecoveries.userId, role: users.role })
      .from(passwordRecoveries)
      .innerJoin(users, eq(users.id, passwordRecoveries.userId))
      .where(eq(passwordRecoveries.id, input.id));
    if (!hint) throw new AccountSecurityError("依頼が見つかりません");
    if (hint.role === "ops" || hint.userId === operatorId)
      throw new AccountSecurityError("運営アカウントはこの画面から復旧できません");
    const [target] = await tx.select().from(users).where(eq(users.id, hint.userId)).for("update");
    const [row] = await tx.select().from(passwordRecoveries).where(eq(passwordRecoveries.id, input.id)).for("update");
    if (!row || target?.status !== "active" || target.role === "ops")
      throw new AccountSecurityError("復旧できるアカウントではありません");
    if (row.issueRequestId === input.requestId) {
      if (
        row.issuedBy !== operatorId ||
        row.verificationMethod !== input.verificationMethod ||
        row.revision < input.revision + 1
      )
        throw new AccountSecurityError("同じ受付番号の内容が異なります");
      return { token: null as string | null, item: view(row, target, clock), replayed: true };
    }
    if (row.revision !== input.revision)
      throw new AccountSecurityError("依頼が変更されています。一覧を更新して確認してください");
    if (!requestAlive(row, clock, target.credentialRevision) || !["requested", "issued"].includes(row.status))
      throw new AccountSecurityError("この依頼は終了しています。本人からあらためて復旧を依頼してください");
    const raw = generateToken(),
      now = clock.now();
    const [issued] = await tx
      .update(passwordRecoveries)
      .set({
        status: "issued",
        revision: row.revision + 1,
        tokenHash: hashToken(raw),
        issuedAt: now,
        expiresAt: new Date(now.getTime() + LINK_LIFETIME),
        issueRequestId: input.requestId,
        issuedBy: operatorId,
        verificationMethod: input.verificationMethod,
      })
      .where(eq(passwordRecoveries.id, row.id))
      .returning();
    await recordEvent(tx, clock, {
      actor: { kind: "ops", userId: operatorId },
      action: "password_recovery.issued",
      targetType: "password_recovery",
      targetId: row.id,
      after: {
        userId: target.id,
        revision: issued!.revision,
        verificationMethod: input.verificationMethod,
        expiresAt: issued!.expiresAt!.toISOString(),
      },
    });
    return { token: raw as string | null, item: view(issued!, target, clock), replayed: false };
  });
  await clearAuthAttempts(db, key);
  return result;
}
export async function cancelPasswordRecovery(
  db: Db,
  clock: Clock,
  token: string,
  input: { id: string; revision: number },
) {
  if (!input || !uuidValid(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1)
    throw new AccountSecurityError("依頼の内容を確認してください");
  const operatorId = await sessionUserId(db, clock, token);
  return db.transaction(async (tx) => {
    await operator(tx, clock, token, operatorId);
    const [hint] = await tx
      .select({ userId: passwordRecoveries.userId, role: users.role })
      .from(passwordRecoveries)
      .innerJoin(users, eq(users.id, passwordRecoveries.userId))
      .where(eq(passwordRecoveries.id, input.id));
    if (!hint) throw new AccountSecurityError("依頼が見つかりません");
    if (hint.role === "ops" || hint.userId === operatorId) throw new AccountSecurityError("運営アカウントは対象外です");
    const [target] = await tx.select().from(users).where(eq(users.id, hint.userId)).for("update");
    const [row] = await tx.select().from(passwordRecoveries).where(eq(passwordRecoveries.id, input.id)).for("update");
    if (!row || !target || target.role === "ops") throw new AccountSecurityError("依頼が見つかりません");
    if (row.status === "cancelled" && row.revision === input.revision + 1) return view(row, target, clock);
    if (row.revision !== input.revision || !["requested", "issued"].includes(row.status))
      throw new AccountSecurityError("依頼が変更されています。一覧を更新して確認してください");
    const [cancelled] = await tx
      .update(passwordRecoveries)
      .set({ status: "cancelled", revision: row.revision + 1, cancelledAt: clock.now() })
      .where(eq(passwordRecoveries.id, row.id))
      .returning();
    await recordEvent(tx, clock, {
      actor: { kind: "ops", userId: operatorId },
      action: "password_recovery.cancelled",
      targetType: "password_recovery",
      targetId: row.id,
      after: { revision: cancelled!.revision },
    });
    return view(cancelled!, target, clock);
  });
}
export async function inspectPasswordRecovery(db: Db, clock: Clock, token: string) {
  if (!tokenValid(token)) return null;
  const [found] = await db
    .select({ recovery: passwordRecoveries, user: users })
    .from(passwordRecoveries)
    .innerJoin(users, eq(users.id, passwordRecoveries.userId))
    .where(eq(passwordRecoveries.tokenHash, hashToken(token)));
  if (!found) return null;
  const { recovery: r, user: u } = found;
  if (
    r.status !== "issued" ||
    !r.expiresAt ||
    r.expiresAt <= clock.now() ||
    u.status !== "active" ||
    u.role === "ops" ||
    r.credentialRevision !== u.credentialRevision
  )
    return null;
  return { expiresAt: r.expiresAt.toISOString() };
}
export async function resetRecoveredPassword(
  db: Db,
  clock: Clock,
  input: { token: string; password: string; confirmation: string },
) {
  if (
    !input ||
    !tokenValid(input.token) ||
    typeof input.password !== "string" ||
    typeof input.confirmation !== "string"
  )
    throw invalidLink();
  const invalid = validatePassword(input.password);
  if (invalid) throw new AccountSecurityError(invalid);
  if (input.password !== input.confirmation) throw new AccountSecurityError("新しいパスワードが一致しません");
  const tokenHash = hashToken(input.token),
    [hint] = await db
      .select({ userId: passwordRecoveries.userId })
      .from(passwordRecoveries)
      .where(eq(passwordRecoveries.tokenHash, tokenHash));
  if (!hint) throw invalidLink();
  if (!(await claimAuthAttempt(db, clock, authAttemptKey("recovery_token", tokenHash))))
    throw new AccountSecurityError("試行回数の上限に達しました。15分ほど待つか、運営に再発行を依頼してください");
  const result = await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, hint.userId)).for("update");
    const [row] = await tx
      .select()
      .from(passwordRecoveries)
      .where(eq(passwordRecoveries.tokenHash, tokenHash))
      .for("update");
    if (!row || user?.status !== "active" || user.role === "ops" || !row.expiresAt || row.expiresAt <= clock.now())
      throw invalidLink();
    if (
      row.status === "consumed" &&
      user.credentialRevision === row.credentialRevision + 1 &&
      (await verifyPassword(input.password, user.passwordHash))
    )
      return { replayed: true, email: user.email };
    if (row.status !== "issued" || row.credentialRevision !== user.credentialRevision) throw invalidLink();
    await tx
      .update(users)
      .set({
        passwordHash: await hashPassword(input.password),
        credentialRevision: user.credentialRevision + 1,
        updatedAt: clock.now(),
      })
      .where(eq(users.id, user.id));
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await tx
      .update(passwordRecoveries)
      .set({ status: "consumed", revision: row.revision + 1, consumedAt: clock.now() })
      .where(eq(passwordRecoveries.id, row.id));
    await recordEvent(tx, clock, {
      actor: { kind: user.role === "customer" ? "customer_user" : "sales", userId: user.id },
      action: "password_recovery.consumed",
      targetType: "password_recovery",
      targetId: row.id,
      after: { credentialRevision: user.credentialRevision + 1 },
    });
    return { replayed: false, email: user.email };
  });
  await clearAuthAttempts(db, authAttemptKey("credential", result.email));
  return { replayed: result.replayed };
}
