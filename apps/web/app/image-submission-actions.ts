"use server";
import {
  authorizeCustomerImageSubmission,
  ContentError,
  type CustomerImageDetails,
  ImageAssetError,
  ImageSubmissionError,
  listCustomerImages,
  listImageSubmissionsForOps,
  reviewCustomerImage,
  reviseCustomerImage,
  submitCustomerImage,
  systemClock,
  withdrawCustomerImage,
} from "@siteoffer/core";
import { normalizeAssetImage } from "@siteoffer/generation/images";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";

function failure(e: unknown) {
  if (e instanceof ContentError || e instanceof ImageAssetError || e instanceof ImageSubmissionError)
    return { ok: false as const, message: e.message };
  throw new Error("処理結果を確認できませんでした。同じ受付で再試行してください");
}
function refresh(companyId: string) {
  revalidatePath("/ops/materials");
  revalidatePath(`/ops/companies/${companyId}`);
  revalidatePath("/customer/materials");
}
export async function submitCustomerImageAction(fd: FormData) {
  try {
    const db = getDb(),
      actor = await getCurrentActor(),
      companyId = String(fd.get("companyId") ?? "");
    await authorizeCustomerImageSubmission(db, actor, companyId);
    const file = fd.get("image");
    if (!(file instanceof File) || file.size < 1 || file.size > 12 * 1024 * 1024)
      return { ok: false as const, message: "12MB以下のPNG・JPEG・WebP画像を選択してください" };
    let image: Awaited<ReturnType<typeof normalizeAssetImage>>;
    try {
      image = await normalizeAssetImage(Buffer.from(await file.arrayBuffer()));
    } catch {
      return {
        ok: false as const,
        message: "画像を読み込めません。12MB以下・2000万画素以下の静止画PNG・JPEG・WebPを選択してください",
      };
    }
    const result = await submitCustomerImage(db, systemClock, actor, {
      companyId,
      requestId: String(fd.get("requestId") ?? ""),
      label: String(fd.get("label") ?? ""),
      rightsBasis: String(fd.get("rightsBasis") ?? "") as CustomerImageDetails["rightsBasis"],
      rightsNote: String(fd.get("rightsNote") ?? ""),
      requestedDemo: fd.get("requestedDemo") === "on",
      requestedProduction: fd.get("requestedProduction") === "on",
      confirmed: fd.get("confirmed") === "on",
      ...image,
    });
    refresh(companyId);
    return { ok: true as const, ...result };
  } catch (e) {
    return failure(e);
  }
}
export async function reviseCustomerImageAction(input: Parameters<typeof reviseCustomerImage>[3]) {
  try {
    const result = await reviseCustomerImage(getDb(), systemClock, await getCurrentActor(), input);
    refresh(input.companyId);
    return { ok: true as const, ...result };
  } catch (e) {
    return failure(e);
  }
}
export async function withdrawCustomerImageAction(input: Parameters<typeof withdrawCustomerImage>[3]) {
  try {
    const result = await withdrawCustomerImage(getDb(), systemClock, await getCurrentActor(), input);
    refresh(input.companyId);
    return { ok: true as const, ...result };
  } catch (e) {
    return failure(e);
  }
}
export async function reviewCustomerImageAction(input: Parameters<typeof reviewCustomerImage>[3]) {
  try {
    const result = await reviewCustomerImage(getDb(), systemClock, await getCurrentActor(), input);
    refresh(input.companyId);
    return { ok: true as const, ...result };
  } catch (e) {
    return failure(e);
  }
}
export async function refreshCustomerImagesAction(companyId: string, page: number) {
  try {
    return { ok: true as const, result: await listCustomerImages(getDb(), await getCurrentActor(), companyId, page) };
  } catch (e) {
    return failure(e);
  }
}
export async function refreshImageSubmissionsAction(input: { companyId?: string; page: number; pendingOnly: boolean }) {
  try {
    return { ok: true as const, result: await listImageSubmissionsForOps(getDb(), await getCurrentActor(), input) };
  } catch (e) {
    return failure(e);
  }
}
