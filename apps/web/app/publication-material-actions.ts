"use server";
import {
  ContentError,
  confirmPublicationMaterialBatch,
  confirmPublicationMaterialCheck,
  getPublicationMaterial,
  getPublicationMaterialBatch,
  listPublicationMaterials,
  PublicationMaterialError,
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
export async function refreshPublicationMaterialsAction(input: Parameters<typeof listPublicationMaterials>[2]) {
  try {
    return { ok: true as const, result: await listPublicationMaterials(getDb(), await getCurrentActor(), input) };
  } catch (e) {
    return failure(e);
  }
}
export async function getPublicationMaterialAction(id: string) {
  try {
    return { ok: true as const, item: await getPublicationMaterial(getDb(), await getCurrentActor(), id) };
  } catch (e) {
    return failure(e);
  }
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

export async function getPublicationMaterialBatchAction(id: string) {
  try {
    return { ok: true as const, preview: await getPublicationMaterialBatch(getDb(), await getCurrentActor(), id) };
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
