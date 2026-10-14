"use server";

import { redirect } from "next/navigation";
import { getAuthProvider, setSessionCookie, takeSessionCookie } from "@/lib/session";

export type AuthFormState = { error?: string; email?: string; displayName?: string } | undefined;

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

export async function loginAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = str(formData.get("email"));
  const password = str(formData.get("password"));
  const r = await getAuthProvider().login({ email, password });
  if (!r.ok) return { error: r.message ?? "ログインできませんでした", email };
  await setSessionCookie(r.value.token, r.value.expiresAt);
  redirect("/");
}

/** 営業ユーザーの自己登録（F-30）。運営アカウントはこの経路では作れない */
export async function registerAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = str(formData.get("email"));
  const password = str(formData.get("password"));
  const displayName = str(formData.get("displayName"));
  const agreed = formData.get("agree") === "on";
  const termsVersionId = str(formData.get("termsVersionId"));
  const provider = getAuthProvider();
  const r = await provider.registerSales({
    email,
    password,
    displayName,
    acceptedTermsVersionId: agreed && termsVersionId ? termsVersionId : null,
  });
  if (!r.ok) return { error: r.message ?? "登録できませんでした", email, displayName };
  const login = await provider.login({ email, password });
  if (!login.ok) redirect("/login");
  await setSessionCookie(login.value.token, login.value.expiresAt);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const token = await takeSessionCookie();
  if (token) await getAuthProvider().logout(token);
  redirect("/login");
}
