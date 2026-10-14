import { getDb } from "@/lib/db";
import { serveImprovedSite, siteSecurityHeaders } from "@/lib/sales/improvement";
import { requireUser } from "@/lib/session";

/**
 * 改善後サイトの静的配信。<artifactDir>/site/ の中だけを返す（判定は lib/sales/improvement.ts）。
 * 未ログインは /login、営業以外は / へ移動（企業詳細と同じ）。見られない企業・無いファイルは 404。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ companyId: string; path?: string[] }> }) {
  const user = await requireUser("sales");
  const { companyId } = await params;
  const headers = siteSecurityHeaders();
  // パスの判定はデコード前の生の値で行う（params はデコード済みのため使わない）
  const rawPathname = new URL(request.url).pathname;
  const r = await serveImprovedSite(getDb(), user.actor, companyId, rawPathname);
  if (!r.ok || r.value.kind === "not_found") {
    return new Response("Not Found", {
      status: 404,
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (r.value.kind === "redirect") {
    return new Response(null, { status: 308, headers: { ...headers, Location: r.value.location } });
  }
  return new Response(new Uint8Array(r.value.body), {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": r.value.contentType,
      "Content-Length": String(r.value.body.length),
    },
  });
}
