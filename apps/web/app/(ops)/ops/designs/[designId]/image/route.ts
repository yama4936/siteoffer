import { designVersions } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { getCurrentActor } from "@/lib/session";
export async function GET(_req: Request, { params }: { params: Promise<{ designId: string }> }) {
  const actor = await getCurrentActor();
  if (actor?.kind !== "ops") return new Response("Forbidden", { status: 403 });
  const { designId } = await params;
  if (!isUuid(designId)) return new Response("Not Found", { status: 404 });
  const [d] = await getDb()
    .select({ image: designVersions.imageBase64 })
    .from(designVersions)
    .where(eq(designVersions.id, designId));
  if (!d?.image) return new Response("Not Found", { status: 404 });
  return new Response(Buffer.from(d.image, "base64"), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}
