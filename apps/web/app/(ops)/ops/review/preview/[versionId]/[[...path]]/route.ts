import { getDb } from "@/lib/db";
import { serveOpsPreview } from "@/lib/ops/preview";
import { getCurrentActor } from "@/lib/session";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const prefix = `/ops/review/preview/${versionId}`;
  const pathname = new URL(request.url).pathname;
  if (pathname === prefix) return Response.redirect(new URL(`${prefix}/index.html`, request.url), 308);
  return serveOpsPreview(getDb(), await getCurrentActor(), versionId, pathname.slice(prefix.length));
}
