"use server";
import {
  type ConsultationCommand,
  ConsultationDraftConflict,
  ConsultationDraftError,
  countUnreadConsultations,
  markConsultationRead,
  type SubmitConsultationDraftInput,
  saveConsultationDraft,
  submitConsultationDraft,
  systemClock,
  updateConsultationCase,
} from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";

export async function submitConsultationAction(input: ConsultationCommand) {
  const actor = await getCurrentActor();
  try {
    const result = await updateConsultationCase(getDb(), systemClock, actor, input);
    if (result.ok) {
      revalidatePath("/ops");
      revalidatePath("/ops/consultations");
      revalidatePath("/sales/consultations");
      revalidatePath("/sales/assignments/[assignmentId]", "page");
    }
    return result;
  } catch {
    return {
      ok: false as const,
      error: "unexpected",
      message: "結果を確認できませんでした。同じ内容で再試行しても二重記録にはなりません",
    };
  }
}

export async function readConsultationAction(activityId: string, revision: number) {
  try {
    const result = await markConsultationRead(getDb(), systemClock, await getCurrentActor(), activityId, revision);
    if (result.ok) {
      revalidatePath("/ops/consultations");
      revalidatePath("/sales/consultations");
    }
    return result;
  } catch {
    return { ok: false as const, error: "unexpected" };
  }
}
export async function unreadConsultationCountAction() {
  try {
    return await countUnreadConsultations(getDb(), await getCurrentActor());
  } catch {
    return { ok: false as const, error: "unexpected" };
  }
}

function draftFailure(e: unknown) {
  if (e instanceof ConsultationDraftConflict) return { status: "conflict" as const, snapshot: e.snapshot };
  return {
    status: "error" as const,
    code: e instanceof ConsultationDraftError ? e.code : "unexpected",
    message:
      e instanceof ConsultationDraftError
        ? e.message
        : "結果を確認できませんでした。入力を残しています。接続を確認して再試行してください",
  };
}
export async function saveConsultationDraftAction(activityId: string, revision: number, values: unknown) {
  try {
    return {
      status: "ok" as const,
      snapshot: await saveConsultationDraft(
        getDb(),
        systemClock,
        await getCurrentActor(),
        activityId,
        revision,
        values,
      ),
    };
  } catch (e) {
    return draftFailure(e);
  }
}
export async function submitConsultationDraftAction(activityId: string, input: SubmitConsultationDraftInput) {
  try {
    const result = await submitConsultationDraft(getDb(), systemClock, await getCurrentActor(), activityId, input);
    revalidatePath("/ops");
    revalidatePath("/ops/consultations");
    revalidatePath("/sales/consultations");
    revalidatePath("/sales/assignments/[assignmentId]", "page");
    return { ...result, caseStatus: result.status, status: "ok" as const };
  } catch (e) {
    return draftFailure(e);
  }
}
