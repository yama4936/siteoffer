import { ContentError, getCustomerImageFile, ImageSubmissionError } from "@siteoffer/core";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";
export async function GET(_req: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const file = await getCustomerImageFile(getDb(), await getCurrentActor(), (await params).assetId);
    if (!file) return new Response("Not Found", { status: 404 });
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex",
        "Content-Disposition": 'inline; filename="material.png"',
      },
    });
  } catch (e) {
    return new Response("Image unavailable", {
      status: e instanceof ContentError || e instanceof ImageSubmissionError ? 403 : 503,
    });
  }
}
