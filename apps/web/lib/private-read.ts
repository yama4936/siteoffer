import {
  type Actor,
  ContentError,
  ImageAssetError,
  ImageSubmissionError,
  PublicationMaterialError,
} from "@siteoffer/core";
import { isUuid } from "./ops/form";
import { getCurrentActor } from "./session";

const headers = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
};
export class ReadInputError extends Error {}
/** Read callbacks retain the domain's live user/company authorization. Never mutate here. */
export async function privateRead<T>(roles: ("ops" | "sales" | "customer_user")[], read: (actor: Actor) => Promise<T>) {
  try {
    const actor = await getCurrentActor();
    if (!actor) return Response.json({ ok: false, message: "ログインし直してください。" }, { status: 401, headers });
    if (!roles.some((role) => actor.kind === role))
      return Response.json({ ok: false, message: "この確認を行う権限がありません。" }, { status: 403, headers });
    return Response.json({ ok: true, result: await read(actor) }, { headers });
  } catch (e) {
    const status = e instanceof ContentError ? 403 : 400;
    if (
      e instanceof ContentError ||
      e instanceof ReadInputError ||
      e instanceof ImageAssetError ||
      e instanceof ImageSubmissionError ||
      e instanceof PublicationMaterialError
    )
      return Response.json({ ok: false, message: e.message }, { status, headers });
    return Response.json(
      { ok: false, message: "最新の状況を取得できません。接続を確認して再度更新してください。" },
      { status: 503, headers },
    );
  }
}
export function queryValue(params: URLSearchParams, name: string) {
  if (params.getAll(name).length > 1) throw new ReadInputError("確認条件を一つずつ指定してください。");
  return params.get(name);
}
export function queryUuid(params: URLSearchParams, name: string, required = false) {
  const value = queryValue(params, name);
  if ((required || value !== null) && !isUuid(value)) throw new ReadInputError("対象の記録を確認してください。");
  return value ?? undefined;
}
export function queryPage(params: URLSearchParams) {
  const value = queryValue(params, "page");
  if (value === null) return 0;
  if (!/^\d{1,6}$/.test(value) || Number(value) > 100000) throw new ReadInputError("ページを確認してください。");
  return Number(value);
}
