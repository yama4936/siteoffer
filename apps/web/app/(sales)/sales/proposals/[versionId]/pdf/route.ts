import { getDb } from "@/lib/db";
import { serveProposalPdf } from "@/lib/ops/proposal-pdf";
import { getCurrentActor } from "@/lib/session";
export const runtime = "nodejs";
export async function GET(_req: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const actor = await getCurrentActor();
  try {
    return await serveProposalPdf(getDb(), actor, "proposal", (await params).versionId);
  } catch {
    return new Response("提案PDFを作成できませんでした。時間をおいて再度お試しください。", {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
