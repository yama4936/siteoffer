import { hasPublishedSite, loadArticleWorkspace } from "@siteoffer/core";
import { companies, contentEntries, contentRevisions } from "@siteoffer/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArticleEditor } from "@/components/ops/article-editor";
import { Flash, first } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { fmtDateOnly } from "@/lib/ops/format";
import { requireUser } from "@/lib/session";
import "../designs/studio.css";

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("ops");
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
  const publicSite = await hasPublishedSite(db, companyId);
  const workspace = await loadArticleWorkspace(db, user.actor, { companyId, entryId: selected?.entry.id ?? null });
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
              {!companyList.some((c) => c.id === companyId) && <option value={companyId}>{company.name}</option>}
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
            <Link className="design-button secondary" href={`/ops/content/${companyId}/import`}>
              既存の記事を取り込む
            </Link>
            <Link className="design-button secondary" href={`/ops/content/${companyId}/preview`}>
              掲載内容をプレビュー
            </Link>
            <a className="design-button secondary" href={`/ops/content/${companyId}/export`}>
              記事をJSONで書き出す
            </a>
          </div>
        </aside>
        <section className="design-card min-w-0 p-5 sm:p-6">
          <h2>{selected ? "記事を編集" : "新しい記事"}</h2>
          {selected?.entry.importId && (
            <div className="mb-4 rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
              <p>ファイルから取り込んだ記事です。</p>
              <p>
                元の掲載日：
                {selected.entry.originalPublishedAt ? fmtDateOnly(selected.entry.originalPublishedAt) : "記録なし"}
              </p>
              {selected.entry.sourceUrl && <p className="break-all">元記事：{selected.entry.sourceUrl}</p>}
            </div>
          )}
          <ArticleEditor
            key={`${companyId}:${selected?.entry.id ?? "new"}`}
            initial={workspace}
            publicSite={publicSite}
          />
        </section>
      </div>
    </div>
  );
}
