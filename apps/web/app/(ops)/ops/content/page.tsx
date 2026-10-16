import { hasPublishedSite } from "@siteoffer/core";
import { companies, contentEntries, contentRevisions } from "@siteoffer/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DesignSubmit } from "@/components/ops/design-controls";
import { Flash, first } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { requireUser } from "@/lib/session";
import { publishArticleAction, saveArticleAction } from "./actions";
import "../designs/studio.css";

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("ops");
  const db = getDb(),
    sp = await searchParams;
  const companyList = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .orderBy(desc(companies.updatedAt))
    .limit(300);
  const companyId = first(sp, "company") ?? companyList[0]?.id;
  if (!companyId) return <p>企業を登録すると記事を管理できます。</p>;
  if (!isUuid(companyId)) notFound();
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) notFound();
  const rows = await db
    .select({ entry: contentEntries, draft: contentRevisions })
    .from(contentEntries)
    .innerJoin(
      contentRevisions,
      and(
        eq(contentRevisions.entryId, contentEntries.id),
        eq(contentRevisions.revision, contentEntries.currentRevision),
      ),
    )
    .where(eq(contentEntries.companyId, companyId))
    .orderBy(desc(contentEntries.updatedAt));
  const id = first(sp, "entry"),
    selected = id ? rows.find((r) => r.entry.id === id) : null;
  if (id && !selected) notFound();
  const history = selected
    ? await db
        .select()
        .from(contentRevisions)
        .where(eq(contentRevisions.entryId, selected.entry.id))
        .orderBy(desc(contentRevisions.revision))
    : [];
  const publicSite = await hasPublishedSite(db, companyId);
  const hidden = (
    <>
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="entryId" value={selected?.entry.id ?? ""} />
      <input type="hidden" name="expectedRevision" value={selected?.entry.currentRevision ?? 0} />
    </>
  );
  return (
    <div className="design-studio">
      <Flash searchParams={sp} />
      <header className="design-heading">
        <div>
          <span className="design-eyebrow">CONTENT MANAGEMENT</span>
          <h1>お知らせ・ブログを更新する</h1>
          <p>下書きと掲載版を分け、過去の版にいつでも戻せます。</p>
        </div>
        <form>
          <label htmlFor="content-company">企業</label>
          <div className="design-inline">
            <select name="company" id="content-company" defaultValue={companyId}>
              {companyList.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button type="submit" className="design-button secondary">
              開く
            </button>
          </div>
        </form>
      </header>
      <div className="design-grid">
        <aside className="design-card design-brief">
          <h2>{company.name}</h2>
          <Link className="design-button" href={`/ops/content?company=${companyId}`}>
            新しい記事を書く
          </Link>
          <p className="design-note">
            {publicSite
              ? "サイト公開済み：掲載版の変更は公開ページに反映されます。"
              : "サイト未公開：記事を掲載版にしても、公開サイトの確認が終わるまで一般公開されません。"}
          </p>
          <nav aria-label="記事一覧">
            {rows.map((r) => (
              <Link
                key={r.entry.id}
                href={`/ops/content?company=${companyId}&entry=${r.entry.id}`}
                style={{ display: "block", padding: "14px 0", borderBottom: "1px solid #e4e9f2", fontSize: 13 }}
              >
                <strong>{r.draft.title}</strong>
                <span style={{ display: "block", fontSize: 11, color: "#70819c", marginTop: 6 }}>
                  {r.entry.publishedRevision ? `掲載 第${r.entry.publishedRevision}版` : "未掲載"} / 下書き 第
                  {r.entry.currentRevision}版
                </span>
              </Link>
            ))}
          </nav>
          <div className="design-actions">
            <Link className="design-button secondary" href={`/ops/content/${companyId}/preview`}>
              掲載内容をプレビュー
            </Link>
            <a className="design-button secondary" href={`/ops/content/${companyId}/export`}>
              記事をJSONで書き出す
            </a>
          </div>
        </aside>
        <section className="design-card design-review">
          <h2>{selected ? "記事を編集" : "新しい記事"}</h2>
          <form action={saveArticleAction} key={selected?.entry.id ?? "new"}>
            {hidden}
            <label>
              記事の種類
              <select
                name="category"
                defaultValue={selected?.draft.category ?? "news"}
                style={{ display: "block", marginTop: 8 }}
              >
                <option value="news">お知らせ</option>
                <option value="blog">ブログ</option>
              </select>
            </label>
            <label>
              見出し
              <input
                name="title"
                required
                maxLength={160}
                defaultValue={selected?.draft.title ?? ""}
                style={{ width: "100%", padding: 12, border: "1px solid #dce2ec", borderRadius: 6, marginTop: 8 }}
              />
            </label>
            <label>
              URL名（作成後は固定）
              <input
                name="slug"
                required
                pattern="[a-z0-9][a-z0-9-]{0,79}"
                maxLength={80}
                readOnly={!!selected}
                defaultValue={selected?.entry.slug ?? ""}
                placeholder="summer-notice"
                style={{ width: "100%", padding: 12, border: "1px solid #dce2ec", borderRadius: 6, marginTop: 8 }}
              />
            </label>
            <label>
              本文
              <textarea name="body" required maxLength={30000} rows={16} defaultValue={selected?.draft.body ?? ""} />
            </label>
            <p className="design-muted">本文は安全なテキストとして表示します。段落は改行で区切ってください。</p>
            <DesignSubmit>下書きを保存</DesignSubmit>
          </form>
          {selected && (
            <>
              <hr style={{ margin: "30px 0", borderColor: "#e4e9f2" }} />
              <h3>掲載する版を選ぶ</h3>
              <form action={publishArticleAction}>
                {hidden}
                <label>
                  掲載版
                  <select
                    name="revision"
                    defaultValue={selected.entry.currentRevision}
                    style={{ display: "block", marginTop: 8 }}
                  >
                    <option value="none">掲載を停止する</option>
                    {history.map((r) => (
                      <option key={r.id} value={r.revision}>
                        第{r.revision}版：{r.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="design-check">
                  <input type="checkbox" name="confirmed" required />
                  内容・利用権利を確認し、この版を掲載します
                </label>
                <DesignSubmit>掲載設定を反映</DesignSubmit>
              </form>
              <details style={{ marginTop: 24 }}>
                <summary>過去の版を確認</summary>
                {history.map((r) => (
                  <article key={r.id} style={{ padding: "18px 0", borderBottom: "1px solid #e4e9f2" }}>
                    <h3>
                      第{r.revision}版 · {r.title}
                    </h3>
                    <p style={{ whiteSpace: "pre-wrap" }}>{r.body}</p>
                  </article>
                ))}
              </details>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
