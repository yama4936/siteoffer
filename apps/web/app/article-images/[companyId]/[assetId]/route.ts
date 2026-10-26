import { ContentError, getArticleEditorImage } from "@siteoffer/core";
import { articleImageResponse } from "@/lib/article-image-response";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";
export async function GET(_req: Request, { params }: { params: Promise<{ companyId: string; assetId: string }> }) {
  try {
    const { companyId, assetId } = await params;
    return articleImageResponse(
      await getArticleEditorImage(getDb(), await getCurrentActor(), companyId, assetId),
      true,
    );
  } catch (e) {
    return new Response("Image unavailable", {
      status: e instanceof ContentError ? 403 : 503,
      headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Robots-Tag": "noindex" },
    });
  }
}
