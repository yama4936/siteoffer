import {
  ContentError,
  hasPublishedSite,
  listArticleImageChoices,
  listCustomerContentCompanies,
  loadArticleWorkspace,
  loadCustomerArticles,
} from "@siteoffer/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArticleEditor } from "@/components/ops/article-editor";
import { first } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import "@/app/(ops)/ops/designs/studio.css";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("customer"),
    db = getDb(),
    sp = await searchParams;
  const companies = await listCustomerContentCompanies(db, user.actor),
    companyId = first(sp, "company") ?? companies[0]?.id;
  if (!companies.length || !companyId)
    return (
      <section className="mx-auto max-w-xl rounded-xl border bg-white p-8">
        <h1 className="text-xl font-bold">記事更新の利用案内をご確認ください</h1>
        <p className="mt-4 leading-7">
          現在、更新できる会社がありません。運営から届いた案内URLで利用を開始するか、利用権限を運営にご確認ください。
        </p>
      </section>
    );
  const company = companies.find((c) => c.id === companyId);
  if (!company) notFound();
  try {
    const rows = await loadCustomerArticles(db, user.actor, companyId),
      entryId = first(sp, "entry") || null;
    if (entryId && !rows.some((r) => r.id === entryId)) notFound();
    const workspace = await loadArticleWorkspace(db, user.actor, { companyId, entryId }),
      publicSite = await hasPublishedSite(db, companyId);
    return (
      <div className="design-studio">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 text-sm text-blue-700">{company.name}</p>
            <h1 className="text-2xl font-bold">お知らせ・ブログを更新</h1>
            <p className="mt-2 text-sm text-slate-500">
              書いて、内容を確認して、掲載する。途中の入力は自動保存されます。
            </p>
          </div>
          {companies.length > 1 && (
            <form>
              <label className="text-sm">
                更新する会社
                <select aria-label="更新する会社" name="company" defaultValue={companyId} className="ml-2">
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="design-button secondary ml-2">
                開く
              </button>
            </form>
          )}
        </header>
        <div className="mb-5 rounded-lg border bg-white p-3 lg:hidden">
          <form key={`${companyId}:${entryId ?? "new"}`} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="company" value={companyId} />
            <label className="min-w-0 flex-1 text-sm">
              編集する記事
              <select aria-label="編集する記事" name="entry" defaultValue={entryId ?? ""} className="mt-2 block w-full">
                <option value="">新しい記事を書く</option>
                {rows.map((r) => (
                  <option value={r.id} key={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="design-button secondary">
              記事を開く
            </button>
          </form>
          <Link
            className="mt-3 block text-sm text-blue-700 underline"
            href={`/customer/content/${companyId}/preview`}
            target="_blank"
          >
            掲載内容を別タブで確認
          </Link>
        </div>
        <div className="grid items-start gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="hidden min-w-0 rounded-xl border bg-white p-5 lg:block">
            <Link className="design-button w-full" href={`/customer/content?company=${companyId}`}>
              新しい記事を書く
            </Link>
            <h2 className="mb-3 mt-6 font-semibold">会社の記事</h2>
            {rows.length === 0 && <p className="text-sm text-slate-500">最初のお知らせを書いてみましょう。</p>}
            <nav aria-label="会社の記事一覧" className="divide-y">
              {rows.map((r) => (
                <Link
                  key={r.id}
                  href={`/customer/content?company=${companyId}&entry=${r.id}`}
                  aria-current={entryId === r.id ? "page" : undefined}
                  className={`block break-words py-4 text-sm ${entryId === r.id ? "font-semibold text-blue-700" : ""}`}
                >
                  <span>{r.title}</span>
                  <span className="mt-1 block text-xs font-normal text-slate-500">
                    {r.publishedRevision ? `掲載 第${r.publishedRevision}版` : "未掲載"} · 下書き 第{r.currentRevision}
                    版
                  </span>
                </Link>
              ))}
            </nav>
            <Link
              className="mt-4 block text-sm text-blue-700 underline"
              href={`/customer/content/${companyId}/preview`}
              target="_blank"
            >
              掲載内容を別タブで確認
            </Link>
            <p className="mt-4 text-xs leading-6 text-slate-500">
              {publicSite
                ? "掲載設定の変更は公開サイトに反映されます。"
                : "サイトはまだ未公開です。記事を準備しておくことができます。"}
            </p>
          </aside>
          <section className="design-card min-w-0 p-5 sm:p-6">
            <h2>{entryId ? "記事を編集" : "新しい記事"}</h2>
            <ArticleEditor
              key={`${companyId}:${entryId ?? "new"}`}
              initial={workspace}
              imageChoices={await listArticleImageChoices(db, user.actor, companyId)}
              publicSite={publicSite}
              audience="customer"
            />
          </section>
        </div>
      </div>
    );
  } catch (e) {
    if (e instanceof ContentError) return <p role="alert">{e.message}</p>;
    throw e;
  }
}
