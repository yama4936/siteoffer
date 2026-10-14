import { type Actor, systemClock } from "@siteoffer/core";
import { type AuthenticatedUser, type AuthProvider, createLocalAuthProvider } from "@siteoffer/core/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "./db";

/** サーバー側専用。Cookieにはセッショントークンだけを入れ、DBにはそのハッシュを保存する */
export const SESSION_COOKIE = "siteoffer_session";

let provider: AuthProvider | undefined;

/** 認証の実装。将来Cognito等へ差し替える場合はここを変える（24.2） */
export function getAuthProvider(): AuthProvider {
  provider ??= createLocalAuthProvider({ db: getDb(), clock: systemClock });
  return provider;
}

/** 現在のユーザー。未ログイン・期限切れ・利用停止なら null。1リクエスト内では1回だけDBを読む */
export const getCurrentUser = cache(async (): Promise<AuthenticatedUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const r = await getAuthProvider().authenticate(token);
  return r.ok ? r.value : null;
});

/** 現在の Actor。権限判定（can / authorize）と業務関数に渡す。未ログインなら null */
export async function getCurrentActor(): Promise<Actor | null> {
  return (await getCurrentUser())?.actor ?? null;
}

/** ログイン必須の画面・処理で使う。未ログインなら /login へ、役割が違えば / へ移動する */
export async function requireUser(role?: "sales" | "ops"): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (role && user.role !== role) redirect("/");
  return user;
}

/** Server Function・Route Handler の中だけで呼べる */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

/** Server Function・Route Handler の中だけで呼べる。トークンを返すので、呼び出し側でセッションを消す */
export async function takeSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  store.delete(SESSION_COOKIE);
  return token;
}
