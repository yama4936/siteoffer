import { contentEntries, contentRevisions } from "@siteoffer/db";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { getCurrentActor } from "@/lib/session";
export async function GET(_req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  if ((await getCurrentActor())?.kind !== "ops") return new Response("Forbidden", { status: 403 });
  const { companyId } = await params;
  if (!isUuid(companyId)) return new Response("Not Found", { status: 404 });
  const db = getDb();
  const entries = await db.select().from(contentEntries).where(eq(contentEntries.companyId, companyId));
  const result = [];
  for (const entry of entries) {
    const revisions = await db
      .select({
        revision: contentRevisions.revision,
        title: contentRevisions.title,
        body: contentRevisions.body,
        category: contentRevisions.category,
        createdAt: contentRevisions.createdAt,
      })
      .from(contentRevisions)
      .where(eq(contentRevisions.entryId, entry.id))
      .orderBy(asc(contentRevisions.revision));
    result.push({ ...entry, revisions });
  }
  return Response.json(
    { schemaVersion: 1, companyId, articles: result },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="articles-${companyId}.json"`,
      },
    },
  );
}
