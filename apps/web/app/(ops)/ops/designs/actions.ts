"use server";
import { randomUUID } from "node:crypto";
import {
  attachDesignImage,
  createDesign,
  DesignError,
  requestDesignBuild,
  retryDesignBuild,
  reviewDesign,
  systemClock,
} from "@siteoffer/core";
import { normalizeDesignImage } from "@siteoffer/generation/images";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { getCurrentActor } from "@/lib/session";

const value = (fd: FormData, key: string) => (typeof fd.get(key) === "string" ? String(fd.get(key)) : "");
async function run(
  fd: FormData,
  operation: (actor: Extract<Awaited<ReturnType<typeof getCurrentActor>>, { kind: "ops" }>) => Promise<string>,
) {
  const actor = await getCurrentActor();
  if (actor?.kind !== "ops") throw new Error("Forbidden");
  const company = value(fd, "companyId");
  if (!isUuid(company)) throw new Error("Invalid company");
  let design = value(fd, "designId");
  let error = "";
  try {
    design = await operation(actor);
  } catch (e) {
    error =
      e instanceof DesignError || (e instanceof Error && /^(画像|静止画|640|変換後)/.test(e.message))
        ? (e as Error).message
        : "処理を完了できませんでした。入力と現在の状態を確認してください";
  }
  revalidatePath("/ops", "layout");
  const query = new URLSearchParams({ company });
  if (isUuid(design)) query.set("design", design);
  query.set(error ? "error" : "msg", error || "保存しました");
  redirect(`/ops/designs?${query}`);
}
export async function createDesignAction(fd: FormData) {
  return run(fd, async (actor) => {
    const source = value(fd, "source") === "openai" ? "openai" : "import";
    const model = process.env.SITEOFFER_IMAGE_MODEL?.trim();
    if (source === "openai" && (!model || !process.env.OPENAI_API_KEY))
      throw new DesignError(
        "画像APIが未設定です。管理者がAPIキーと画像モデルを設定するか、imagegenで作った画像を取り込んでください",
      );
    const auditId = value(fd, "auditId");
    if (!isUuid(auditId)) throw new DesignError("対象の診断がありません");
    const brief = Object.fromEntries(
      ["objective", "audience", "direction", "scope", "updatePlan"].map((k) => [k, value(fd, k)]),
    );
    const key = value(fd, "requestKey") || randomUUID();
    const row = await createDesign(getDb(), systemClock, actor, {
      companyId: value(fd, "companyId"),
      auditId,
      requestKey: key,
      brief,
      source,
      ...(model ? { model } : {}),
    });
    return row.id;
  });
}
export async function uploadDesignAction(fd: FormData) {
  return run(fd, async (actor) => {
    const id = value(fd, "designId");
    if (!isUuid(id)) throw new DesignError("デザインIDが不正です");
    const file = fd.get("image");
    if (!(file instanceof File) || file.size > 12 * 1024 * 1024)
      throw new DesignError("12MB以下の画像を選択してください");
    const image = await normalizeDesignImage(Buffer.from(await file.arrayBuffer()));
    await attachDesignImage(getDb(), systemClock, actor, id, image);
    return id;
  });
}
export async function reviewDesignAction(fd: FormData) {
  return run(fd, async (actor) => {
    const id = value(fd, "designId");
    if (!isUuid(id)) throw new DesignError("デザインIDが不正です");
    await reviewDesign(getDb(), systemClock, actor, {
      id,
      approve: value(fd, "decision") === "approve",
      note: value(fd, "note"),
      factsChecked: fd.has("facts"),
      rightsChecked: fd.has("rights"),
      layoutChecked: fd.has("layout"),
    });
    return id;
  });
}
export async function buildDesignAction(fd: FormData) {
  return run(fd, async (actor) => {
    const id = value(fd, "designId");
    if (!isUuid(id)) throw new DesignError("デザインIDが不正です");
    await requestDesignBuild(getDb(), systemClock, actor, id);
    return id;
  });
}

export async function retryDesignBuildAction(fd: FormData) {
  return run(fd, async (actor) => {
    const id = value(fd, "designId");
    if (!isUuid(id)) throw new DesignError("デザインIDが不正です");
    return (await retryDesignBuild(getDb(), systemClock, actor, id)).id;
  });
}
