import { type Db, sessions, termsAcceptances, users } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import type { Clock } from "../common/clock.ts";
import { HOUR } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok } from "../common/result.ts";
import { getSetting } from "../common/settings.ts";
import { generateToken, hashPassword, hashToken, verifyPassword } from "./crypto.ts";
import type { AuthenticatedUser, AuthProvider } from "./provider.ts";
import { getLatestTerms } from "./terms.ts";
import {
  isUniqueViolation,
  normalizeEmail,
  validateDisplayName,
  validateEmail,
  validatePassword,
} from "./validation.ts";

type UserRow = typeof users.$inferSelect;

function toAuthenticated(u: UserRow): AuthenticatedUser {
  const actor = u.role === "ops" ? { kind: "ops" as const, userId: u.id } : { kind: "sales" as const, userId: u.id };
  return { actor, userId: u.id, email: u.email, displayName: u.displayName, role: u.role };
}

/** 存在しないメールでも同程度の時間をかけ、応答時間から登録の有無を推測されにくくする */
let dummyHash: Promise<string> | undefined;

export interface LocalAuthProviderOptions {
  db: Db;
  clock: Clock;
  /** 省略時は運営設定 session.ttlHours */
  sessionTtlMs?: number;
}

/** ローカル版の簡易ログイン：メール＋パスワード（scrypt）と、DBに保存するセッション */
export function createLocalAuthProvider({ db, clock, sessionTtlMs }: LocalAuthProviderOptions): AuthProvider {
  return {
    async registerSales(input) {
      const email = normalizeEmail(input.email);
      if (!validateEmail(email)) return err("invalid_email", "メールアドレスの形式が正しくありません");
      const pw = validatePassword(input.password);
      if (pw) return err("weak_password", pw);
      const displayName = input.displayName.trim();
      if (!validateDisplayName(displayName)) return err("invalid_display_name", "表示名は1〜100文字で入力してください");

      const terms = await getLatestTerms(db);
      if (!terms) return err("terms_unavailable", "利用条件が登録されていません");
      if (!input.acceptedTermsVersionId) return err("terms_not_accepted", "利用条件への同意が必要です");
      if (input.acceptedTermsVersionId !== terms.id) {
        return err("terms_outdated", "利用条件が更新されました。最新の利用条件を確認してください");
      }

      const passwordHash = await hashPassword(input.password);
      try {
        const userId = await db.transaction(async (tx) => {
          const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
          if (existing) return null;
          const now = clock.now();
          const [user] = await tx
            .insert(users)
            .values({ email, passwordHash, displayName, role: "sales", createdAt: now, updatedAt: now })
            .returning();
          await tx.insert(termsAcceptances).values({ userId: user!.id, termsVersionId: terms.id, acceptedAt: now });
          const actor = { kind: "sales" as const, userId: user!.id };
          await recordEvent(tx, clock, {
            actor,
            action: "user.registered",
            targetType: "user",
            targetId: user!.id,
            after: { role: "sales", status: "active" },
          });
          await recordEvent(tx, clock, {
            actor,
            action: "terms.accepted",
            targetType: "terms_version",
            targetId: terms.id,
            after: { version: terms.version },
          });
          return user!.id;
        });
        if (!userId) return err("email_taken", "このメールアドレスは登録済みです");
        return ok({ userId });
      } catch (e) {
        if (isUniqueViolation(e)) return err("email_taken", "このメールアドレスは登録済みです");
        throw e;
      }
    },

    async login(input) {
      const email = normalizeEmail(input.email);
      const [user] = await db.select().from(users).where(eq(users.email, email));
      if (!user) {
        dummyHash ??= hashPassword("dummy-password-for-timing");
        await verifyPassword(input.password, await dummyHash);
        return err("invalid_credentials", "メールアドレスまたはパスワードが違います");
      }
      if (!(await verifyPassword(input.password, user.passwordHash))) {
        return err("invalid_credentials", "メールアドレスまたはパスワードが違います");
      }
      if (user.status !== "active") return err("suspended", "このアカウントは利用停止中です");

      const ttl = sessionTtlMs ?? (await getSetting(db, "session.ttlHours")) * HOUR;
      const token = generateToken();
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + ttl);
      const authed = toAuthenticated(user);
      await db.transaction(async (tx) => {
        const [session] = await tx
          .insert(sessions)
          .values({ tokenHash: hashToken(token), userId: user.id, expiresAt, createdAt: now })
          .returning({ id: sessions.id });
        await recordEvent(tx, clock, {
          actor: authed.actor,
          action: "session.created",
          targetType: "session",
          targetId: session!.id,
          after: { expiresAt: expiresAt.toISOString() },
        });
      });
      return ok({ token, expiresAt, user: authed });
    },

    async authenticate(token) {
      if (!token) return err("invalid_session");
      const [row] = await db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.tokenHash, hashToken(token)));
      if (!row) return err("invalid_session");
      if (row.session.expiresAt.getTime() <= clock.now().getTime()) return err("session_expired");
      if (row.user.status !== "active") return err("suspended");
      return ok(toAuthenticated(row.user));
    },

    async logout(token) {
      if (!token) return;
      await db.transaction(async (tx) => {
        const deleted = await tx
          .delete(sessions)
          .where(eq(sessions.tokenHash, hashToken(token)))
          .returning({ id: sessions.id, userId: sessions.userId });
        const [s] = deleted;
        if (!s) return;
        const [u] = await tx.select({ role: users.role }).from(users).where(eq(users.id, s.userId));
        await recordEvent(tx, clock, {
          actor: u?.role === "ops" ? { kind: "ops", userId: s.userId } : { kind: "sales", userId: s.userId },
          action: "session.deleted",
          targetType: "session",
          targetId: s.id,
        });
      });
    },
  };
}
