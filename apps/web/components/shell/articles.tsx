export function Articles({
  name,
  articles,
  preview = false,
}: {
  name: string;
  articles: { slug: string; title: string; body: string; category: string; publishedAt: Date | null }[];
  preview?: boolean;
}) {
  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "50px 24px", color: "#172a46", fontFamily: "sans-serif" }}>
      {preview && (
        <p style={{ padding: 15, background: "#eef2ff", color: "#3156e9" }}>
          運営用プレビュー / 一般公開されていることを示す画面ではありません
        </p>
      )}
      <header style={{ borderBottom: "2px solid #172a46", padding: "30px 0", marginBottom: 40 }}>
        <p>{name}</p>
        <h1 style={{ fontSize: 32, marginTop: 15 }}>お知らせ・ブログ</h1>
      </header>
      {!articles.length && <p>掲載されている記事はありません。</p>}
      {articles.map((a) => (
        <article
          key={a.slug}
          id={a.slug}
          style={{ padding: "0 0 42px", marginBottom: 38, borderBottom: "1px solid #e2e7ef" }}
        >
          <p style={{ color: "#708099", fontSize: 12 }}>
            {a.category === "blog" ? "ブログ" : "お知らせ"} ·{" "}
            {a.publishedAt?.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}
          </p>
          <h2 style={{ fontSize: 23, margin: "14px 0 24px" }}>{a.title}</h2>
          <div style={{ fontSize: 15, lineHeight: 2, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{a.body}</div>
        </article>
      ))}
    </main>
  );
}
