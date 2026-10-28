"use server";
import {
  type CompanyEditorInviteInput,
  ContentError,
  inviteCompanyEditor,
  loadCompanyContentAccess,
  revokeCompanyEditor,
  systemClock,
} from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";

/** 顧客の管理者による自社の編集者の招待（T23の(c)）。役割は core で editor に固定される */
export async function inviteCompanyEditorAction(input: CompanyEditorInviteInput) {
  try {
    const { access, token } = await inviteCompanyEditor(getDb(), systemClock, await getCurrentActor(), input);
    revalidatePath(`/customer/team/${input.companyId}`);
    // 顧客には契約IDを渡さない（一覧の loadCompanyContentAccess と同じ扱い）
    const { contractId: _contractId, ...view } = access;
    return { status: "ok" as const, access: view, token };
  } catch (e) {
    if (e instanceof ContentError) return { status: "error" as const, message: e.message };
    throw new Error("招待の結果を確認できませんでした");
  }
}
/** 顧客の管理者による自社の編集者の解除。自分自身と管理者は core が拒否する */
export async function revokeCompanyEditorAction(input: { companyId: string; accessId: string; revision: number }) {
  try {
    const { contractId: _contractId, ...access } = await revokeCompanyEditor(
      getDb(),
      systemClock,
      await getCurrentActor(),
      input,
    );
    revalidatePath(`/customer/team/${input.companyId}`);
    return { status: "ok" as const, access };
  } catch (e) {
    if (e instanceof ContentError) return { status: "error" as const, message: e.message };
    throw new Error("解除の結果を確認できませんでした");
  }
}
export async function refreshCompanyTeamAction(companyId: string) {
  try {
    return {
      status: "ok" as const,
      value: await loadCompanyContentAccess(getDb(), await getCurrentActor(), companyId),
    };
  } catch (e) {
    return { status: "error" as const, message: e instanceof ContentError ? e.message : "一覧を確認できませんでした" };
  }
}
