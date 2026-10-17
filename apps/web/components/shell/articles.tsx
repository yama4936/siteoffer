import type { PublishedArticlesView } from "@siteoffer/core";
import Link from "next/link";
import { articleHref } from "@/lib/article-view";
import "./articles.css";

const date = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "Asia/Tokyo",
});
function ArticleDate({ value }: { value: Date | null }) {
  return value ? <time dateTime={value.toISOString()}>{date.format(value)}</time> : <span>掲載日未記録</span>;
}
export function Articles({
  name,
  view,
  basePath,
  preview = false,
}: {
  name: string;
  view: PublishedArticlesView;
  basePath: string;
  preview?: boolean;
}) {
  const filters = view.kind === "list" ? view.data.filters : view.filters;
  return (
    <main className="articles-shell" id="siteoffer_articles_top">
      {preview && (
        <p className="articles-preview">掲載内容のプレビュー / 一般公開されていることを示す画面ではありません</p>
      )}
      <header className="articles-header">
        <p className="articles-company">{name}</p>
        <p className="articles-eyebrow">NEWS & JOURNAL</p>
        <h1>{view.kind === "article" ? view.article.title : "お知らせ・ブログ"}</h1>
        {view.kind === "list" && (
          <p className="articles-description">日々のお知らせと、私たちの取り組みをご紹介します。</p>
        )}
      </header>
      {view.kind === "article" ? (
        <>
          <Link className="articles-back" href={articleHref(basePath, filters)} prefetch={false}>
            ← 記事一覧に戻る
          </Link>
          <article className="articles-detail" id={view.article.slug}>
            <p className="articles-meta">
              <span className="articles-category">{view.article.category === "blog" ? "ブログ" : "お知らせ"}</span>
              <ArticleDate value={view.article.publishedAt} />
            </p>
            <div className="articles-body">{view.article.body}</div>
          </article>
          <Link className="articles-back" href={articleHref(basePath, filters)} prefetch={false}>
            ← 記事一覧に戻る
          </Link>
        </>
      ) : (
        <>
          <search aria-label="掲載記事を検索">
            <form
              className="articles-search"
              method="get"
              action={basePath}
              key={`${filters.query}:${filters.category}`}
            >
              <label className="articles-search-query">
                キーワード
                <input
                  type="search"
                  name="q"
                  defaultValue={filters.query}
                  maxLength={120}
                  placeholder="見出しや本文から探す"
                />
              </label>
              <div className="articles-search-category">
                <label htmlFor="article-category">記事の種類</label>
                <select id="article-category" name="category" defaultValue={filters.category}>
                  <option value="all">すべての記事</option>
                  <option value="news">お知らせ</option>
                  <option value="blog">ブログ</option>
                </select>
              </div>
              <button type="submit">検索する</button>
              {(filters.query || filters.category !== "all") && (
                <Link className="articles-clear" href={basePath} prefetch={false}>
                  条件をクリア
                </Link>
              )}
            </form>
          </search>
          <div className="articles-results" role="status">
            <p>
              <strong>{view.data.total.toLocaleString("ja-JP")}</strong> 件の記事
              {view.data.total > 0 && (
                <span>
                  {" "}
                  / {(filters.page - 1) * view.data.pageSize + 1}〜
                  {Math.min(filters.page * view.data.pageSize, view.data.total)}件を表示
                </span>
              )}
            </p>
            <p>
              {filters.page} / {view.data.pageCount} ページ
            </p>
          </div>
          {!view.data.items.length && (
            <div className="articles-empty">
              <h2>
                {filters.query || filters.category !== "all"
                  ? "条件に合う記事が見つかりませんでした"
                  : "掲載されている記事はありません"}
              </h2>
              <p>
                {filters.query || filters.category !== "all"
                  ? "キーワードや記事の種類を変えてお試しください。"
                  : "新しいお知らせを、こちらでお伝えしていきます。"}
              </p>
            </div>
          )}
          <div className="articles-list">
            {view.data.items.map((a) => (
              <article className="articles-card" key={a.slug} id={a.slug}>
                <p className="articles-meta">
                  <span className="articles-category">{a.category === "blog" ? "ブログ" : "お知らせ"}</span>
                  <ArticleDate value={a.publishedAt} />
                </p>
                <h2>
                  <Link href={articleHref(basePath, filters, a.slug)} prefetch={false}>
                    {a.title}
                  </Link>
                </h2>
                <p className="articles-excerpt">
                  {a.excerpt}
                  {a.excerpt.length >= 280 ? "…" : ""}
                </p>
                <Link
                  className="articles-read"
                  href={articleHref(basePath, filters, a.slug)}
                  prefetch={false}
                  aria-label={`${a.title}を読む`}
                >
                  記事を読む <span aria-hidden="true">↗</span>
                </Link>
              </article>
            ))}
          </div>
          {view.data.pageCount > 1 && (
            <nav className="articles-pagination" aria-label="記事のページ切り替え">
              {filters.page > 1 ? (
                <Link rel="prev" href={articleHref(basePath, { ...filters, page: filters.page - 1 })} prefetch={false}>
                  ← 新しい記事
                </Link>
              ) : (
                <span />
              )}
              <span>
                {filters.page} / {view.data.pageCount}
              </span>
              {filters.page < view.data.pageCount ? (
                <Link rel="next" href={articleHref(basePath, { ...filters, page: filters.page + 1 })} prefetch={false}>
                  過去の記事 →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
      <footer className="articles-footer">
        <span>{name}</span>
        <a href="#siteoffer_articles_top">ページの先頭へ ↑</a>
      </footer>
    </main>
  );
}
