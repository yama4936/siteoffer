"use server";
import {
  attachDesignImage,
  DesignError,
  requestDesignBuild,
  retryDesignBuild,
  reviewDesign,
  switchDesignToImport,
  systemClock,
} from "@siteoffer/core";
import { normalizeDesignImage } from "@siteoffer/generation/images";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import type { DesignCreateResult, DesignDraftResult, DesignDraftScope } from "@/lib/ops/design-draft-types";
import { createDesignFromDraft, DesignDraftConflict, DesignDraftError, saveDesignDraft } from "@/lib/ops/design-drafts";
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
function draftError(e: unknown): Exclude<DesignDraftResult, { status: "ok" }> {
  if (e instanceof DesignDraftConflict) return { status: "conflict", snapshot: e.snapshot };
  return {
    status: "error",
    message:
      e instanceof DesignDraftError || e instanceof DesignError
        ? e.message
        : "保存できませんでした。入力は残っています。接続を確認して再試行してください",
  };
}
export async function saveDesignDraftAction(
  scope: DesignDraftScope,
  revision: number,
  values: unknown,
): Promise<DesignDraftResult> {
  try {
    return {
      status: "ok",
      snapshot: await saveDesignDraft(getDb(), systemClock, await getCurrentActor(), scope, revision, values),
    };
  } catch (e) {
    return draftError(e);
  }
}
export async function createDesignAction(
  scope: DesignDraftScope,
  input: {
    revision: number;
    brief: unknown;
    requestKey: string;
    source: "openai" | "import";
  },
): Promise<DesignCreateResult> {
  try {
    const actor = await getCurrentActor();
    if (actor?.kind !== "ops") throw new DesignDraftError("運営としてログインしてください");
    const model = process.env.SITEOFFER_IMAGE_MODEL?.trim();
    const id = await createDesignFromDraft(getDb(), systemClock, actor, scope, {
      revision: input.revision,
      brief: input.brief,
      requestKey: input.requestKey,
      source: input.source,
      ...(model ? { model } : {}),
    });
    revalidatePath("/ops", "layout");
    return {
      status: "ok",
      url: `/ops/designs?${new URLSearchParams({ company: scope.companyId, design: id, msg: "制作条件を新しい版に保存しました" })}`,
    };
  } catch (e) {
    return draftError(e);
  }
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
export async function switchDesignInputAction(fd: FormData) {
  return run(fd, async (actor) => {
    const designId = value(fd, "designId");
    const companyId = value(fd, "companyId");
    if (!isUuid(designId)) throw new DesignError("デザインIDが不正です");
    await switchDesignToImport(getDb(), systemClock, actor, { designId, companyId });
    return designId;
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
    const versionId = value(fd, "proposalVersionId");
    if (!isUuid(versionId)) throw new DesignError("再制作する元の提案版を確認してください");
    return (await retryDesignBuild(getDb(), systemClock, actor, id, versionId)).id;
  });
}
