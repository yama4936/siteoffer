import { hasPublishedSite } from "@siteoffer/core";
import { companies } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Articles } from "@/components/shell/articles";
import { loadArticleView } from "@/lib/article-view";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { companyId } = await params,
    sp = await searchParams;
  if (!isUuid(companyId)) notFound();
  const result = await getDb().transaction(
    async (tx) => {
      if (!(await hasPublishedSite(tx, companyId))) return null;
      const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
      if (!company) return null;
      const view = await loadArticleView(tx, companyId, sp);
      return view ? { name: company.name, view } : null;
    },
    { isolationLevel: "repeatable read" },
  );
  if (!result) notFound();
  return <Articles {...result} basePath={`/published/${companyId}/news`} />;
}
