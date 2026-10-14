import { type DbOrTx, sessions, termsAcceptances, users } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok, type Result } from "../common/result.ts";
import { authorize } from "../permissions/policy.ts";
import { hashPassword } from "./crypto.ts";
import { getLatestTerms } from "./terms.ts";
import { normalizeEmail, validateEmail, validatePassword } from "./validation.ts";

export type SetUserStatusError = "unauthenticated" | "forbidden" | "not_found" | "already_in_state";

async function setUserStatus(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  userId: string,
  status: "active" | "suspended",
  reason: string | undefined,
): Promise<Result<void, SetUserStatusError>> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!user) {
      // 存在の有無を運営以外に教えないよう、先に権限を確かめる
      if (!actor) return err("unauthenticated");
      if (actor.kind !== "ops" && actor.kind !== "system") return err("forbidden");
      return err("not_found");
    }
    const auth = authorize(actor, status === "suspended" ? "suspend" : "reactivate", {
      type: "user",
      userId: user.id,
      role: user.role,
    });
    if (!auth.ok) return auth;
    if (user.status === status) return err("already_in_state");
    await tx.update(users).set({ status, updatedAt: clock.now() }).where(eq(users.id, user.id));
    if (status === "suspended") {
      // 利用停止と同時に既存のセッションを無効にする（authenticate でも状態を確認する）
      await tx.delete(sessions).where(eq(sessions.userId, user.id));
    }
    await recordEvent(tx, clock, {
      actor: actor!,
      action: status === "suspended" ? "user.suspended" : "user.reactivated",
      targetType: "user",
      targetId: user.id,
      before: { status: user.status },
      after: { status, reason: reason ?? null },
    });
    return ok(undefined);
  });
}

/** 運営が営業ユーザーを利用停止にする。停止中はログインも既存セッションでの操作もできない */
export function suspendUser(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  userId: string,
  reason?: string,
): Promise<Result<void, SetUserStatusError>> {
  return setUserStatus(db, clock, actor, userId, "suspended", reason);
}

export function reactivateUser(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  userId: string,
  reason?: string,
): Promise<Result<void, SetUserStatusError>> {
  return setUserStatus(db, clock, actor, userId, "active", reason);
}

export type CreateUserError = "invalid_email" | "weak_password" | "email_taken" | "terms_unavailable";

/**
 * サーバー内部（seed・運営の管理手順）からユーザーを作る。画面からは呼ばない。
 * 運営アカウントはこの経路だけで作る（自己登録させない）。
 * 営業ユーザーの場合は最新の利用条件への同意も記録する（自己登録と同じ状態にそろえる）。
 */
export async function createUserBySystem(
  db: DbOrTx,
  clock: Clock,
  input: { email: string; password: string; displayName: string; role: "sales" | "ops"; job: string },
): Promise<Result<{ userId: string }, CreateUserError>> {
  const email = normalizeEmail(input.email);
  if (!validateEmail(email)) return err("invalid_email");
  const pw = validatePassword(input.password);
  if (pw) return err("weak_password", pw);
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) return err("email_taken");
    const terms = input.role === "sales" ? await getLatestTerms(tx) : null;
    if (input.role === "sales" && !terms) return err("terms_unavailable");
    const now = clock.now();
    const [user] = await tx
      .insert(users)
      .values({ email, passwordHash, displayName: input.displayName, role: input.role, createdAt: now, updatedAt: now })
      .returning();
    if (terms) {
      await tx.insert(termsAcceptances).values({ userId: user!.id, termsVersionId: terms.id, acceptedAt: now });
    }
    await recordEvent(tx, clock, {
      actor: { kind: "system", job: input.job },
      action: "user.created",
      targetType: "user",
      targetId: user!.id,
      after: { role: input.role, status: "active", termsVersion: terms?.version ?? null },
    });
    return ok({ userId: user!.id });
  });
}
