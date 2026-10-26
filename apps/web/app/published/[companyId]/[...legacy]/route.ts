import { articleLegacyResponse } from "@/lib/article-legacy-response";
export async function GET(request: Request, { params }: { params: Promise<{ companyId: string; legacy: string[] }> }) {
  return articleLegacyResponse(request, (await params).companyId);
}
export const HEAD = GET;
