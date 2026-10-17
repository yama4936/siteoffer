"use client";
import type { ManagedArticlePage } from "@siteoffer/core";
import Link from "next/link";
import { useState } from "react";
import { type ContentIndexQuery, contentIndexHref } from "@/lib/content-index-query";
import { ContentFilterForm, ContentFilterLink } from "./content-filter-navigation";
import { ContentIndexFields } from "./content-index-fields";

const date = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Tokyo",
});
export function ContentArticleFinder({
  data,
  query,
  base,
  audience,
}: {
  data: ManagedArticlePage;
  query: ContentIndexQuery;
  base: string;
  audience: "ops" | "customer";
}) {
  const [open, setOpen] = useState(false),
    full = query.view === "list";
  return (
    <section className="design-card min-w-0 p-4" aria-label="記事を探す" id="content-article-list">
      {!full && (
        <button
          type="button"
          className="w-full rounded border bg-slate-50 p-3 text-left font-semibold lg:hidden"
          aria-expanded={open}
          aria-controls="content-article-results"
          onClick={() => setOpen(!open)}
        >
          記事を探す・絞り込む（{data.total.toLocaleString()}件）{open ? " −" : " ＋"}
        </button>
      )}
      <div id="content-article-results" className={full ? "block" : `${open ? "block" : "hidden"} lg:block`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">会社の記事</h2>
          <Link
            className="design-button"
            href={contentIndexHref(base, { ...query, view: "new", entryId: null })}
            prefetch={false}
          >
            新しい記事を書く
          </Link>
        </div>
        <ContentFilterForm
          action={base}
          className={`grid min-w-0 gap-3 ${full ? "sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_180px_190px_auto]" : ""}`}
          key={JSON.stringify(query.filters)}
        >
          <ContentIndexFields query={query} omit={["q", "category", "publication", "page"]} />
          <label className="min-w-0 text-sm">
            キーワード
            <input
              type="search"
              name="q"
              defaultValue={query.filters.query}
              maxLength={120}
              className="mt-2 block w-full rounded border p-2"
              placeholder="見出し・本文・URLで検索"
            />
          </label>
          <div className="text-sm">
            <label htmlFor="content-filter-category">記事の種類で絞り込み</label>
            <select
              id="content-filter-category"
              name="category"
              defaultValue={query.filters.category}
              className="mt-2 block w-full rounded border p-2"
            >
              <option value="all">すべて</option>
              <option value="news">お知らせ</option>
              <option value="blog">ブログ</option>
            </select>
          </div>
          <div className="text-sm">
            <label htmlFor="content-filter-publication">掲載状態</label>
            <select
              id="content-filter-publication"
              name="publication"
              defaultValue={query.filters.publication}
              className="mt-2 block w-full rounded border p-2"
            >
              <option value="all">すべて</option>
              <option value="unpublished">未掲載・掲載停止</option>
              <option value="published">掲載中</option>
              <option value="changes">掲載中・変更あり</option>
            </select>
          </div>
          <button className="design-button secondary self-end" type="submit">
            記事を検索
          </button>
        </ContentFilterForm>
        <div className="my-4 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500">
          <p>
            {data.total.toLocaleString()}件
            {data.total > 0
              ? `中 ${((data.filters.page - 1) * data.pageSize + 1).toLocaleString()}〜${Math.min(data.filters.page * data.pageSize, data.total).toLocaleString()}件`
              : ""}
          </p>
          {(query.filters.query || query.filters.category !== "all" || query.filters.publication !== "all") && (
            <ContentFilterLink
              className="text-blue-700 underline"
              href={contentIndexHref(base, {
                ...query,
                filters: { page: 1, query: "", category: "all", publication: "all" },
              })}
            >
              記事の条件をクリア
            </ContentFilterLink>
          )}
        </div>
        {query.entryId && !data.items.some((i) => i.id === query.entryId) && (
          <p className="mb-3 rounded bg-blue-50 p-3 text-xs leading-6 text-blue-800">
            編集中の記事は現在の条件・ページの一覧外です。内容はそのまま編集できます。
          </p>
        )}
        {data.total === 0 && (
          <p className="rounded border border-dashed p-5 text-sm leading-7">
            条件に合う記事がありません。条件を変えるか、新しい記事を書いてください。
          </p>
        )}
        <nav
          aria-label={audience === "customer" ? "会社の記事一覧" : "記事一覧"}
          className={full ? "grid gap-3 md:grid-cols-2" : "max-h-[55vh] overflow-y-auto divide-y"}
        >
          {data.items.map((row) => (
            <Link
              prefetch={false}
              key={row.id}
              onClick={() => setOpen(false)}
              href={`${contentIndexHref(base, { ...query, view: "edit", entryId: row.id })}#article-editor`}
              aria-current={query.entryId === row.id ? "page" : undefined}
              className={`block min-w-0 break-words rounded-lg p-3 text-sm ${full ? "border" : ""} ${query.entryId === row.id ? "border-blue-300 bg-blue-50" : "hover:bg-slate-50"}`}
            >
              <span className="block font-semibold text-slate-900">{row.title}</span>
              {row.publishedTitle && row.publishedTitle !== row.title && (
                <span className="mt-1 block text-xs text-slate-500">掲載中：{row.publishedTitle}</span>
              )}
              <span className="mt-2 block text-xs text-slate-500">
                {row.category === "blog" ? "ブログ" : "お知らせ"}・
                {row.publishedRevision === null
                  ? row.publicationRevision > 0
                    ? "掲載停止"
                    : "未掲載"
                  : row.publishedRevision !== row.currentRevision
                    ? "掲載中・変更あり"
                    : "掲載中"}
                ・第{row.currentRevision}版
              </span>
              <span className="mt-1 block break-all text-xs text-slate-400">
                {row.slug} / {date.format(new Date(row.updatedAt))}
              </span>
            </Link>
          ))}
        </nav>
        {data.pageCount > 1 && (
          <nav aria-label="管理記事のページ切り替え" className="mt-4 flex items-center justify-between gap-2 text-sm">
            {data.filters.page > 1 ? (
              <ContentFilterLink
                className="text-blue-700"
                href={contentIndexHref(base, { ...query, filters: { ...query.filters, page: data.filters.page - 1 } })}
              >
                ← 前の記事
              </ContentFilterLink>
            ) : (
              <span />
            )}
            <span className="text-slate-500">
              {data.filters.page} / {data.pageCount}
            </span>
            {data.filters.page < data.pageCount ? (
              <ContentFilterLink
                className="text-blue-700"
                href={contentIndexHref(base, { ...query, filters: { ...query.filters, page: data.filters.page + 1 } })}
              >
                次の記事 →
              </ContentFilterLink>
            ) : (
              <span />
            )}
          </nav>
        )}
      </div>
    </section>
  );
}
