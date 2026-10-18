import { type ArticlePublicationStatus, articlePublicationLabel } from "@/lib/article-publication-status";

export function ArticlePublication({
  companyId,
  slug,
  audience,
  ...state
}: ArticlePublicationStatus & { companyId: string; slug: string; audience: "ops" | "customer" }) {
  const hasPublication = state.publishedRevision !== null;
  const path = `${encodeURIComponent(companyId)}/preview?${new URLSearchParams({ article: slug })}`;
  return (
    <section className="article-publication" aria-label="この記事の掲載状況">
      <div className="article-publication-heading">
        <h3>この記事の掲載状況</h3>
        <span className="article-publication-badge">{articlePublicationLabel(state)}</span>
      </div>
      <p>
        {hasPublication
          ? `第${state.publishedRevision}版を${state.publicSite ? "掲載しています。" : "掲載する設定です。サイトはまだ未公開です。"}`
          : state.publicationRevision > 0
            ? "掲載を停止しています。保存した版と作業コピーは残っています。"
            : "まだ掲載していません。下書きを保存してから、掲載する版を確認してください。"}
      </p>
      {hasPublication && state.currentRevision !== state.publishedRevision && (
        <p>共有下書きの第{state.currentRevision}版は、まだ掲載内容に反映していません。</p>
      )}
      {hasPublication && (
        <>
          <div className="article-publication-links">
            <a
              className="design-button secondary"
              href={`/${audience === "customer" ? "customer" : "ops"}/content/${path}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {state.publicSite ? "現在の掲載内容を確認" : "掲載予定の内容を確認"} ↗
            </a>
            {state.publicSite && (
              <a
                className="design-button secondary"
                href={`/published/${encodeURIComponent(companyId)}/news?${new URLSearchParams({ article: slug })}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                公開中の記事を開く ↗
              </a>
            )}
          </div>
          <p className="article-publication-note">
            別タブで開くため、入力中の画面はそのまま残ります。作業コピーや未掲載の下書きは含まれません。
          </p>
        </>
      )}
    </section>
  );
}
