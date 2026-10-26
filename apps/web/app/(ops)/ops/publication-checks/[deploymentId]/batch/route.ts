import {
  ContentError,
  getPublicationMaterialBatch,
  getPublicationReopenBatch,
  PublicationMaterialError,
} from "@siteoffer/core";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";

const headers = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
};
export async function GET(request: Request, { params }: { params: Promise<{ deploymentId: string }> }) {
  try {
    const actor = await getCurrentActor();
    if (!actor)
      return Response.json({ ok: false, message: "運営としてログインしてください。" }, { status: 401, headers });
    if (actor.kind !== "ops")
      return Response.json({ ok: false, message: "運営権限が必要です。" }, { status: 403, headers });
    const mode = new URL(request.url).searchParams.get("mode"),
      { deploymentId } = await params;
    if (mode !== "confirm" && mode !== "reopen")
      return Response.json({ ok: false, message: "確認する操作を指定してください。" }, { status: 400, headers });
    const preview =
      mode === "confirm"
        ? await getPublicationMaterialBatch(getDb(), actor, deploymentId)
        : await getPublicationReopenBatch(getDb(), actor, deploymentId);
    return Response.json({ ok: true, preview }, { headers });
  } catch (e) {
    if (e instanceof ContentError) return Response.json({ ok: false, message: e.message }, { status: 403, headers });
    if (e instanceof PublicationMaterialError)
      return Response.json({ ok: false, message: e.message }, { status: 400, headers });
    return Response.json(
      { ok: false, message: "対象を取得できませんでした。再度更新してください。" },
      { status: 503, headers },
    );
  }
}
