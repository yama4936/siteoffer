import { hasPublishedSite, publishedArticles } from "@siteoffer/core";
import { companies } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Articles } from "@/components/shell/articles";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  if (!isUuid(companyId)) notFound();
  const db = getDb();
  if (!(await hasPublishedSite(db, companyId))) notFound();
  const [c] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
  if (!c) notFound();
  return <Articles name={c.name} articles={await publishedArticles(db, companyId)} />;
}
