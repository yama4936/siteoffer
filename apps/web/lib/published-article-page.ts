import { hasPublishedSite, publishedSiteHomeUrl } from "@siteoffer/core";
import { companies, type DbOrTx } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { articleHref, loadArticleView, parseArticleQuery } from "./article-view";
import { isUuid } from "./ops/form";

type Search = Record<string, string | string[] | undefined>;
/** The metadata and visible page share the same public-access gate and database snapshot. */
export async function readPublishedArticlePage(db: DbOrTx, companyId: string, search: Search) {
  if (!isUuid(companyId) || !parseArticleQuery(search)) return null;
  return db.transaction(
    async (tx) => {
      if (!(await hasPublishedSite(tx, companyId))) return null;
      const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
      if (!company) return null;
      const view = await loadArticleView(tx, companyId, search);
      return view ? { companyId, name: company.name, view, homeUrl: await publishedSiteHomeUrl(tx, companyId) } : null;
    },
    { isolationLevel: "repeatable read" },
  );
}
export type PublicArticlePage = NonNullable<Awaited<ReturnType<typeof readPublishedArticlePage>>>;

function configuredOrigin(value: string | undefined) {
  if (
    !value ||
    value.length > 2048 ||
    value !== value.trim() ||
    Array.from(value).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return { origin: url.origin, local };
  } catch {
    return null;
  }
}
const excerpt = (text: string) => {
  const compact = text.replace(/\s+/gu, " ").trim();
  const codepoints = Array.from(compact);
  return codepoints.length > 160 ? `${codepoints.slice(0, 159).join("")}…` : compact;
};

/** Never derives canonical URLs from request headers, the old source site, or a preview URL. */
export function publishedArticleMetadata(
  page: PublicArticlePage,
  options: { origin?: string; demo?: boolean } = {},
): Metadata {
  const article = page.view.kind === "article" ? page.view.article : null;
  const filters = page.view.kind === "list" ? page.view.data.filters : page.view.filters;
  const listLabel = filters.query
    ? "記事の検索結果"
    : filters.category === "news"
      ? "お知らせ"
      : filters.category === "blog"
        ? "ブログ"
        : "お知らせ・ブログ";
  const title = `${article?.title || listLabel}${!article && filters.page > 1 ? `（${filters.page}ページ目）` : ""} | ${page.name}`;
  const description = article ? excerpt(article.body) : `${page.name}のお知らせ・ブログを掲載しています。`;
  const configured = configuredOrigin(options.origin);
  const path = articleHref(
    `/published/${page.companyId}/news`,
    article ? { page: 1, query: "", category: "all" } : filters,
    article?.slug,
  );
  const canonical = configured ? new URL(path, configured.origin).href : undefined;
  const index = !!configured && !configured.local && !options.demo && (!!article || !filters.query);
  const date = article?.publishedAt;
  return {
    title,
    description,
    robots: { index, follow: true },
    ...(canonical ? { alternates: { canonical } } : {}),
    openGraph: {
      title,
      description,
      siteName: page.name,
      locale: "ja_JP",
      ...(canonical ? { url: canonical } : {}),
      ...(article
        ? { type: "article", ...(date && Number.isFinite(date.getTime()) ? { publishedTime: date.toISOString() } : {}) }
        : { type: "website" }),
    },
    twitter: { card: "summary", title, description },
  };
}
