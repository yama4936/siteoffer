import { authorizeContentEditor, ContentError, publishedArticles } from "@siteoffer/core";
import { companies } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Articles } from "@/components/shell/articles";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
export default async function Page({ params }: { params: Promise<{ companyId: string }> }) {
  const user = await requireUser("customer"),
    { companyId } = await params;
  try {
    const view = await getDb().transaction(async (tx) => {
      await authorizeContentEditor(tx, user.actor, companyId);
      const [c] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
      return { name: c!.name, articles: await publishedArticles(tx, companyId) };
    });
    return <Articles {...view} preview />;
  } catch (e) {
    if (e instanceof ContentError) notFound();
    throw e;
  }
}
