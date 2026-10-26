"use server";
import {
  ContentError,
  confirmPublicationMaterialBatch,
  confirmPublicationMaterialCheck,
  PublicationMaterialError,
  reopenPublicationMaterialBatch,
  reopenPublicationMaterialCheck,
  systemClock,
} from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";

function failure(e: unknown) {
  if (e instanceof ContentError || e instanceof PublicationMaterialError)
    return { ok: false as const, message: e.message };
  throw new Error("処理結果を確認できません。同じ受付で再試行してください。");
}
export async function confirmPublicationMaterialAction(input: Parameters<typeof confirmPublicationMaterialCheck>[3]) {
  try {
    const result = await confirmPublicationMaterialCheck(getDb(), systemClock, await getCurrentActor(), input);
    revalidatePath("/ops/publication-checks");
    revalidatePath("/ops");
    return { ok: true as const, ...result };
  } catch (e) {
    return failure(e);
  }
}
export async function reopenPublicationMaterialAction(input: Parameters<typeof reopenPublicationMaterialCheck>[3]) {
  try {
    const result = await reopenPublicationMaterialCheck(getDb(), systemClock, await getCurrentActor(), input);
    revalidatePath("/ops/publication-checks");
    revalidatePath("/ops");
    return { ok: true as const, ...result };
  } catch (e) {
    return failure(e);
  }
}

export async function confirmPublicationMaterialBatchAction(
  input: Parameters<typeof confirmPublicationMaterialBatch>[3],
) {
  try {
    const result = await confirmPublicationMaterialBatch(getDb(), systemClock, await getCurrentActor(), input);
    revalidatePath("/ops/publication-checks");
    revalidatePath("/ops");
    return { ok: true as const, ...result };
  } catch (e) {
    return failure(e);
  }
}

export async function reopenPublicationMaterialBatchAction(
  input: Parameters<typeof reopenPublicationMaterialBatch>[3],
) {
  try {
    const result = await reopenPublicationMaterialBatch(getDb(), systemClock, await getCurrentActor(), input);
    revalidatePath("/ops/publication-checks");
    revalidatePath("/ops");
    return { ok: true as const, ...result };
  } catch (e) {
    return failure(e);
  }
}
