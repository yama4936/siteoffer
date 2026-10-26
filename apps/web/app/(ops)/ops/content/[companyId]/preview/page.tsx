import { publishedSiteHomeUrl } from "@siteoffer/core";
import { companies } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Articles } from "@/components/shell/articles";
import { loadArticleView } from "@/lib/article-view";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { requireUser } from "@/lib/session";
export const metadata = { robots: { index: false, follow: false } };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("ops");
  const { companyId } = await params,
    sp = await searchParams;
  if (!isUuid(companyId)) notFound();
  const result = await getDb().transaction(
    async (tx) => {
      const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
      if (!company) return null;
      const view = await loadArticleView(tx, companyId, sp);
      return view ? { name: company.name, view, homeUrl: await publishedSiteHomeUrl(tx, companyId) } : null;
    },
    { isolationLevel: "repeatable read" },
  );
  if (!result) notFound();
  return <Articles companyId={companyId} {...result} basePath={`/ops/content/${companyId}/preview`} preview />;
}
