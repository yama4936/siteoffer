import { getDb } from "@/lib/db";
import { serveReviewDesignImage } from "@/lib/ops/review-design";
import { getCurrentActor } from "@/lib/session";

export async function GET(_request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  return serveReviewDesignImage(getDb(), await getCurrentActor(), (await params).versionId);
}
