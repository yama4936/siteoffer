"use server";
import { AccountSecurityError, changeOwnPassword, systemClock } from "@siteoffer/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { SESSION_COOKIE, takeSessionCookie } from "@/lib/session";
export async function changePasswordAction(input: {
  currentPassword: string;
  newPassword: string;
  confirmation: string;
  expectedRevision: number;
}) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return { ok: false as const, message: "もう一度ログインしてください" };
  try {
    await changeOwnPassword(getDb(), systemClock, token, input);
  } catch (error) {
    if (error instanceof AccountSecurityError) return { ok: false as const, message: error.message };
    throw error;
  }
  await takeSessionCookie();
  redirect("/login?passwordChanged=1");
}
