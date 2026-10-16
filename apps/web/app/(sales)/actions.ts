"use server";

// 営業画面の Server Action。直接POSTでも呼べるため、actor は毎回 Cookie から取り直し、
// 権限・業務条件の判定は core の業務関数（lib/sales/operations.ts 経由）に任せる。
import { systemClock } from "@siteoffer/core";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import type { SalesActionState } from "@/lib/sales/action-state";
import type { ActivityCommitResult, ActivityDraftResult } from "@/lib/sales/activity-draft-types";
import {
  ActivityDraftConflict,
  ActivityDraftError,
  commitActivityDraft,
  saveActivityDraft,
} from "@/lib/sales/activity-drafts";
import { claimCompany, releaseMyAssignment, reportDeal, type SalesDeps, saveDomainWish } from "@/lib/sales/operations";
import { checkProposalShare, issueProposalShare, revokeProposalShare } from "@/lib/sales/share";
import { getCurrentActor } from "@/lib/session";

async function deps(): Promise<SalesDeps> {
  return { db: getDb(), clock: systemClock, actor: await getCurrentActor() };
}

export async function claimAction(_prev: SalesActionState, formData: FormData): Promise<SalesActionState> {
  const r = await claimCompany(await deps(), formData);
  if (r?.status === "ok" && r.assignmentId) redirect(`/sales/assignments/${r.assignmentId}`);
  return r;
}

export async function releaseAction(_prev: SalesActionState, formData: FormData): Promise<SalesActionState> {
  const r = await releaseMyAssignment(await deps(), formData);
  if (r?.status === "ok") refresh();
  return r;
}

function activityDraftError(e: unknown): Exclude<ActivityDraftResult, { status: "ok" }> {
  if (e instanceof ActivityDraftConflict) return { status: "conflict", snapshot: e.snapshot };
  return {
    status: "error",
    message:
      e instanceof ActivityDraftError
        ? e.message
        : "保存できませんでした。入力を残しています。接続を確認して再試行してください",
  };
}
export async function saveActivityDraftAction(
  assignmentId: string,
  revision: number,
  values: unknown,
): Promise<ActivityDraftResult> {
  try {
    const d = await deps();
    return { status: "ok", snapshot: await saveActivityDraft(d.db, d.clock, d.actor, assignmentId, revision, values) };
  } catch (e) {
    return activityDraftError(e);
  }
}
export async function commitActivityDraftAction(
  assignmentId: string,
  input: { revision: number; values: unknown; requestKey: string; confirmEnd: boolean },
): Promise<ActivityCommitResult> {
  try {
    const d = await deps();
    const result = await commitActivityDraft(d.db, d.clock, d.actor, assignmentId, input);
    return { status: "ok", ...result };
  } catch (e) {
    return activityDraftError(e);
  }
}

export async function saveDomainWishAction(_prev: SalesActionState, formData: FormData): Promise<SalesActionState> {
  const r = await saveDomainWish(await deps(), formData);
  if (r?.status === "ok") refresh();
  return r;
}

export async function reportDealAction(_prev: SalesActionState, formData: FormData): Promise<SalesActionState> {
  const r = await reportDeal(await deps(), formData);
  if (r?.status === "ok") refresh();
  return r;
}

/** 提案の共有リンクの発行。URL（トークン）は戻り値でだけ返し、リダイレクトのクエリには載せない */
export async function issueShareAction(_prev: SalesActionState, formData: FormData): Promise<SalesActionState> {
  const r = await issueProposalShare(await deps(), formData);
  if (r?.status === "ok") refresh();
  return r;
}

export async function revokeShareAction(_prev: SalesActionState, formData: FormData): Promise<SalesActionState> {
  const r = await revokeProposalShare(await deps(), formData);
  if (r?.status === "ok") refresh();
  return r;
}

/** URLのコピー前に現在の担当・承認・営業抑止・期限を確認する。URL自体は送信しない。 */
export async function checkShareAction(proposalVersionId: string, linkId: string) {
  try {
    return await checkProposalShare(await deps(), proposalVersionId, linkId);
  } catch {
    return {
      status: "error" as const,
      message: "リンクの状態を確認できません。接続を確認して、もう一度コピーしてください。",
      unavailable: false,
    };
  }
}
