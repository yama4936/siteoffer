import {
  type Actor,
  ContentError,
  hasPublishedSite,
  listArticleImageChoices,
  listContentManagementCompanies,
  listManagedArticles,
  loadArticleWorkspace,
  loadContentAccess,
} from "@siteoffer/core";
import { companies, contentEntries } from "@siteoffer/db";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { contentIndexHref, parseContentIndexQuery } from "@/lib/content-index-query";
import { getDb } from "@/lib/db";
import { fmtDateOnly } from "@/lib/ops/format";
import { ArticleEditor } from "./article-editor";
import { ContentAccessManager } from "./content-access-manager";
import { ContentArticleFinder } from "./content-article-finder";
import { ContentCompanyPicker } from "./content-company-picker";
import { Flash } from "./ui";

export async function ContentWorkspacePage({
  actor,
  audience,
  search,
}: {
  actor: Actor;
  audience: "ops" | "customer";
  search: Record<string, string | string[] | undefined>;
}) {
  const input = parseContentIndexQuery(search);
  if (!input) notFound();
  const db = getDb(),
    base = audience === "ops" ? "/ops/content" : "/customer/content";
  try {
    const companyPage = await listContentManagementCompanies(db, actor, input.companies);
    const companyId = input.companyId ?? companyPage.items[0]?.id;
    if (!companyId)
      return (
        <div className="design-studio space-y-5">
          <h1 className="text-2xl font-bold">お知らせ・ブログを更新</h1>
          <ContentCompanyPicker data={companyPage} current={null} query={input} base={base} />
          <p className="rounded-xl border bg-white p-6 leading-7">
            {input.companies.query
              ? "検索条件を変えて会社を探してください。"
              : audience === "customer"
                ? "現在、更新できる会社がありません。運営から届いた利用案内をご確認ください。"
                : "企業を登録すると記事を管理できます。"}
          </p>
        </div>
      );
    const listing = await listManagedArticles(db, actor, companyId, input.filters);
    const [company] = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company) notFound();
    const query = { ...input, companyId, filters: listing.filters, companies: companyPage.filters };
    // Selecting an article is independent from the current list page and filters.
    const workspace =
      query.view === "list" ? null : await loadArticleWorkspace(db, actor, { companyId, entryId: query.entryId });
    const [selected] = query.entryId
      ? await db
          .select({
            importId: contentEntries.importId,
            sourceUrl: contentEntries.sourceUrl,
            originalPublishedAt: contentEntries.originalPublishedAt,
          })
          .from(contentEntries)
          .where(and(eq(contentEntries.id, query.entryId), eq(contentEntries.companyId, companyId)))
      : [];
    const publicSite = await hasPublishedSite(db, companyId);
    return (
      <div className="design-studio">
        {audience === "ops" && <Flash searchParams={search} />}
        <header className="mb-6 flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="mb-2 break-words text-sm text-blue-700">{company.name}</p>
            <h1 className="text-2xl font-bold">お知らせ・ブログを更新</h1>
            <p className="mt-2 text-sm leading-7 text-slate-500">
              記事を探す、内容を確認する、掲載する。途中の入力は自動保存されます。
            </p>
            <p className="mt-2 text-xs leading-6 text-slate-500">
              {publicSite
                ? "掲載設定の変更は公開サイトに反映されます。"
                : "サイトはまだ未公開です。記事を準備しておくことができます。"}
            </p>
          </div>
          {(audience === "ops" || companyPage.total > 1 || companyPage.filters.query) && (
            <ContentCompanyPicker data={companyPage} current={company} query={query} base={base} />
          )}
        </header>
        <div className="mb-5 flex flex-wrap gap-3">
          {query.view !== "list" && (
            <Link
              className="design-button secondary"
              href={contentIndexHref(base, { ...query, view: "list", entryId: null })}
              prefetch={false}
            >
              一覧へ戻る
            </Link>
          )}
          <Link
            className="design-button secondary"
            href={`${base}/${companyId}/preview`}
            target="_blank"
            prefetch={false}
          >
            掲載内容を別タブで確認
          </Link>
          {audience === "ops" && (
            <>
              <Link className="design-button secondary" href={`/ops/content/${companyId}/migration`}>
                旧URLの引き継ぎ
              </Link>
              <Link className="design-button secondary" href={`/ops/content/${companyId}/import`}>
                既存の記事を取り込む
              </Link>
              <a className="design-button secondary" href={`/ops/content/${companyId}/export`}>
                記事をJSONで書き出す
              </a>
            </>
          )}
        </div>
        <div className={workspace ? "grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]" : ""}>
          <ContentArticleFinder
            key={`${companyId}:${query.view}`}
            data={listing}
            query={query}
            base={base}
            audience={audience}
            publicSite={publicSite}
          />
          {workspace && (
            <section className="design-card min-w-0 scroll-mt-6 p-5 sm:p-6" id="article-editor">
              <h2>{query.entryId ? "記事を編集" : "新しい記事"}</h2>
              {selected?.importId && (
                <div className="mb-4 space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
                  <p>ファイルから取り込んだ記事です。</p>
                  <p>
                    元の掲載日：{selected.originalPublishedAt ? fmtDateOnly(selected.originalPublishedAt) : "記録なし"}
                  </p>
                  {selected.sourceUrl && <p className="break-all">元記事：{selected.sourceUrl}</p>}
                </div>
              )}
              <ArticleEditor
                key={`${companyId}:${query.entryId ?? "new"}`}
                initial={workspace}
                imageChoices={await listArticleImageChoices(db, actor, companyId)}
                publicSite={publicSite}
                audience={audience}
                listContext={query}
              />
            </section>
          )}
        </div>
        {audience === "ops" && (
          <div className="mt-6">
            <ContentAccessManager key={companyId} initial={await loadContentAccess(db, actor, companyId)} />
          </div>
        )}
      </div>
    );
  } catch (e) {
    if (e instanceof ContentError) notFound();
    throw e;
  }
}
