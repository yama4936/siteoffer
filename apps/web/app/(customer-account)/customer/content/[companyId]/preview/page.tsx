import { authorizeContentEditor, ContentError } from "@siteoffer/core";
import { companies } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Articles } from "@/components/shell/articles";
import { loadArticleView } from "@/lib/article-view";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
export const metadata = { robots: { index: false, follow: false } };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("customer"),
    { companyId } = await params,
    sp = await searchParams;
  try {
    const result = await getDb().transaction(
      async (tx) => {
        await authorizeContentEditor(tx, user.actor, companyId);
        const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
        if (!company) return null;
        const view = await loadArticleView(tx, companyId, sp);
        return view ? { name: company.name, view } : null;
      },
      { isolationLevel: "repeatable read" },
    );
    if (!result) notFound();
    return <Articles companyId={companyId} {...result} basePath={`/customer/content/${companyId}/preview`} preview />;
  } catch (e) {
    if (e instanceof ContentError) notFound();
    throw e;
  }
}
