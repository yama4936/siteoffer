"use server";

// 営業画面の Server Action。直接POSTでも呼べるため、actor は毎回 Cookie から取り直し、
// 権限・業務条件の判定は core の業務関数（lib/sales/operations.ts 経由）に任せる。
import { systemClock } from "@siteoffer/core";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import type { SalesActionState } from "@/lib/sales/action-state";
import {
  claimCompany,
  recordSalesActivity,
  releaseMyAssignment,
  reportDeal,
  type SalesDeps,
  saveDomainWish,
} from "@/lib/sales/operations";
import { issueProposalShare, revokeProposalShare } from "@/lib/sales/share";
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

export async function recordActivityAction(_prev: SalesActionState, formData: FormData): Promise<SalesActionState> {
  const r = await recordSalesActivity(await deps(), formData);
  if (r?.status === "ok") refresh();
  return r;
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
