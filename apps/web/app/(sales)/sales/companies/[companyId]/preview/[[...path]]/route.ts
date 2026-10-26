import { getDb } from "@/lib/db";
import { serveSalesPreview } from "@/lib/sales/site-preview";
import { getCurrentActor } from "@/lib/session";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const prefix = `/sales/companies/${companyId}/preview`;
  const pathname = new URL(request.url).pathname;
  if (pathname === prefix) return Response.redirect(new URL(`${prefix}/index.html`, request.url), 308);
  return serveSalesPreview(getDb(), await getCurrentActor(), companyId, pathname.slice(prefix.length));
}
