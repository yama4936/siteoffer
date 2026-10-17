"use client";
import type { getPublicationMaterialBatch, getPublicationReopenBatch } from "@siteoffer/core";

type Previews = {
  confirm: Awaited<ReturnType<typeof getPublicationMaterialBatch>>;
  reopen: Awaited<ReturnType<typeof getPublicationReopenBatch>>;
};
type Result<T> = { ok: true; preview: T } | { ok: false; message: string };
/** Read-only requests can be aborted without entering the Server Action mutation queue. */
export async function readPublicationPreview<K extends keyof Previews>(
  deploymentId: string,
  mode: K,
  signal: AbortSignal,
): Promise<Result<Previews[K]>> {
  const response = await fetch(`/ops/publication-checks/${encodeURIComponent(deploymentId)}/batch?mode=${mode}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  const body = await response.json();
  if (!response.ok || body?.ok === false)
    return {
      ok: false,
      message: typeof body?.message === "string" ? body.message : "対象を取得できませんでした。再度更新してください。",
    };
  if (body?.ok !== true || !body.preview) throw new Error("Invalid preview response");
  return body as Result<Previews[K]>;
}
