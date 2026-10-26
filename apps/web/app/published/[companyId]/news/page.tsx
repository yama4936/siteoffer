import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Articles } from "@/components/shell/articles";
import { parseArticleQuery } from "@/lib/article-view";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { publishedArticleMetadata, readPublishedArticlePage } from "@/lib/published-article-page";
export const dynamic = "force-dynamic";
type Props = {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
// React's request-scoped cache shares the public snapshot between metadata and the body.
const loadPage = cache((companyId: string, search: string) =>
  readPublishedArticlePage(getDb(), companyId, JSON.parse(search)),
);
async function pageData({ params, searchParams }: Props) {
  const [{ companyId }, search] = await Promise.all([params, searchParams]);
  const parsed = parseArticleQuery(search);
  if (!isUuid(companyId) || !parsed) notFound();
  const result = await loadPage(
    companyId,
    JSON.stringify({
      page: String(parsed.filters.page),
      q: parsed.filters.query,
      category: parsed.filters.category,
      ...(parsed.slug ? { article: parsed.slug } : {}),
    }),
  );
  if (!result) notFound();
  return result;
}
export async function generateMetadata(props: Props): Promise<Metadata> {
  const result = await pageData(props);
  return publishedArticleMetadata(result, {
    origin: process.env.SITEOFFER_CONTENT_ORIGIN?.trim() || process.env.WEB_BASE_URL,
    demo: process.env.SITEOFFER_DEMO_MODE === "true" || !!process.env.DEMO_RESTORE_DIR,
  });
}
export default async function Page(props: Props) {
  const result = await pageData(props);
  return <Articles {...result} basePath={`/published/${result.companyId}/news`} />;
}
