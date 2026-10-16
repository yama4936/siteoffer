"use server";
import {
  AccountSecurityError,
  cancelPasswordRecovery,
  type IssueRecoveryInput,
  issuePasswordRecovery,
  listPasswordRecoveries,
  requestPasswordRecovery,
  resetRecoveredPassword,
  systemClock,
} from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/session";

async function token() {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? "";
}
function failure(error: unknown) {
  if (error instanceof AccountSecurityError) return { ok: false as const, message: error.message };
  throw new Error("処理結果を確認できませんでした");
}
export async function requestRecoveryAction(email: string) {
  try {
    await requestPasswordRecovery(getDb(), systemClock, email);
    return { ok: true as const };
  } catch (error) {
    return failure(error);
  }
}
export async function resetRecoveryAction(input: { token: string; password: string; confirmation: string }) {
  try {
    await resetRecoveredPassword(getDb(), systemClock, input);
    // Keep the consumed-token page mounted long enough to show success. The ops inbox polls fresh data.
    return { ok: true as const };
  } catch (error) {
    return failure(error);
  }
}
export async function issueRecoveryAction(input: IssueRecoveryInput) {
  try {
    const result = await issuePasswordRecovery(getDb(), systemClock, await token(), input);
    revalidatePath("/ops/account-recovery");
    return { ok: true as const, ...result };
  } catch (error) {
    return failure(error);
  }
}
export async function cancelRecoveryAction(input: { id: string; revision: number }) {
  try {
    const item = await cancelPasswordRecovery(getDb(), systemClock, await token(), input);
    revalidatePath("/ops/account-recovery");
    return { ok: true as const, item };
  } catch (error) {
    return failure(error);
  }
}
export async function refreshRecoveriesAction(input: { page: number; history: boolean }) {
  try {
    const result = await listPasswordRecoveries(getDb(), systemClock, await token(), input);
    return { ok: true as const, result };
  } catch (error) {
    return failure(error);
  }
}
