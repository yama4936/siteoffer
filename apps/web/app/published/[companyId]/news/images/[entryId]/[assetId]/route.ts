import { ContentError, getPublishedArticleImage } from "@siteoffer/core";
import { articleImageResponse } from "@/lib/article-image-response";
import { getDb } from "@/lib/db";
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ companyId: string; entryId: string; assetId: string }> },
) {
  try {
    const { companyId, entryId, assetId } = await params;
    return articleImageResponse(await getPublishedArticleImage(getDb(), companyId, entryId, assetId));
  } catch (e) {
    return new Response("Image unavailable", {
      status: e instanceof ContentError ? 404 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
