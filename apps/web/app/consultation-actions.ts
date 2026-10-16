"use server";
import { type ConsultationCommand, systemClock, updateConsultationCase } from "@siteoffer/core";
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
