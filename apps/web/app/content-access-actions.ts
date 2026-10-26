"use server";
import {
  acceptContentInvitation,
  type ContentAccessInput,
  ContentError,
  inviteContentEditor,
  loadContentAccess,
  revokeContentEditor,
  systemClock,
} from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getAuthProvider, getCurrentActor, setSessionCookie } from "@/lib/session";
export async function inviteContentEditorAction(input: ContentAccessInput) {
  try {
    const result = await inviteContentEditor(getDb(), systemClock, await getCurrentActor(), input);
    revalidatePath("/ops/content");
    return { status: "ok" as const, ...result };
  } catch (e) {
    if (e instanceof ContentError) return { status: "error" as const, message: e.message };
    throw new Error("招待の発行結果を確認できませんでした");
  }
}
export async function revokeContentEditorAction(input: { companyId: string; accessId: string; revision: number }) {
  try {
    const access = await revokeContentEditor(getDb(), systemClock, await getCurrentActor(), input);
    revalidatePath("/ops/content");
    revalidatePath("/customer/content");
    return { status: "ok" as const, access };
  } catch (e) {
    if (e instanceof ContentError) return { status: "error" as const, message: e.message };
    throw new Error("利用停止の結果を確認できませんでした");
  }
}
export async function refreshContentAccessAction(companyId: string) {
  try {
    return { status: "ok" as const, value: await loadContentAccess(getDb(), await getCurrentActor(), companyId) };
  } catch (e) {
    return { status: "error" as const, message: e instanceof ContentError ? e.message : "一覧を確認できませんでした" };
  }
}
export async function acceptContentInvitationAction(input: {
  token: string;
  displayName: string;
  password: string;
  confirmed: boolean;
}) {
  try {
    const result = await acceptContentInvitation(getDb(), systemClock, input);
    const login = await getAuthProvider().login({ email: result.email, password: input.password });
    if (!login.ok)
      return { status: "error" as const, message: login.message ?? "ログインできませんでした。もう一度お試しください" };
    await setSessionCookie(login.value.token, login.value.expiresAt);
    return { status: "ok" as const, companyId: result.companyId };
  } catch (e) {
    return {
      status: "error" as const,
      message:
        e instanceof ContentError ? e.message : "利用開始の結果を確認できませんでした。同じ内容で再試行してください",
    };
  }
}
