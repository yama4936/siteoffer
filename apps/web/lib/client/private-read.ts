"use client";
import { PrivateReadFailure, readPrivateJson } from "./private-json";

export type PrivateReadResult<T> = { ok: true; result: T } | { ok: false; message: string };
/** Bound read waits and keep them outside the Server Action mutation queue. */
export async function readPrivate<T>(path: string, signal?: AbortSignal): Promise<PrivateReadResult<T>> {
  const { response, body } = await readPrivateJson(path, { signal });
  const value = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!response.ok || value?.ok === false)
    return {
      ok: false,
      message:
        typeof value?.message === "string" ? value.message : "最新の状況を取得できません。再度更新してください。",
    };
  if (value?.ok !== true || !("result" in value)) throw new PrivateReadFailure("invalid_response");
  return { ok: true, result: value.result as T };
}
