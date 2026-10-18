import { ContentError, listArticleLegacyPaths } from "@siteoffer/core";
import { companies } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArticleLegacy } from "@/components/ops/article-legacy";
import { PageHeader } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { requireUser } from "@/lib/session";
export default async function MigrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("ops"),
    { companyId } = await params,
    sp = await searchParams;
  if (!isUuid(companyId) || [sp.q, sp.page, sp.state].some((value) => value !== undefined && typeof value !== "string"))
    notFound();
  const page = sp.page ?? "1",
    query = sp.q ?? "",
    state = sp.state ?? "all";
  if (
    typeof page !== "string" ||
    !/^[1-9]\d*$/.test(page) ||
    typeof query !== "string" ||
    (state !== "all" && state !== "active" && state !== "inactive")
  )
    notFound();
  const db = getDb(),
    [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
  if (!company) notFound();
  const data = await listArticleLegacyPaths(db, user.actor, companyId, { page: Number(page), query, state }).catch(
    (error) => {
      if (error instanceof ContentError) notFound();
      throw error;
    },
  );
  const href = (next: number) =>
    `/ops/content/${companyId}/migration?${new URLSearchParams({ q: data.query, state: data.state, page: String(next) })}`;
  return (
    <>
      <PageHeader title="旧URLの引き継ぎ" description={`${company.name}の記事へ、旧URLから移動できるようにします。`} />
      <p className="mb-4 text-sm">
        <Link href={`/ops/content?company=${companyId}`} className="text-primary underline">
          記事管理へ戻る
        </Link>
      </p>
      <div className="mb-5 rounded-xl border bg-blue-50 p-5 text-sm leading-7">
        <p>
          取り込んだ元記事URLから候補を作成します。元URLがない記事はパスを指定できます。自動では有効になりません。記事とサイトが公開されている場合だけ、同じ会社の掲載記事へ転送します。下書きや取り下げた記事へは転送しません。
        </p>
        <p>
          この公開サイトのパス配下で動作します。元のドメイン・DNSの切替や外部サイトへの設定変更は行いません。公開先の接続設定は別途必要です。
        </p>
        <code className="break-all">公開サイト：/published/{companyId}</code>
      </div>
      <form method="get" className="mb-5 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          旧URL・記事URL名
          <input type="search" name="q" maxLength={120} defaultValue={data.query} className="ml-2 rounded border p-2" />
        </label>
        <label className="text-sm">
          設定状態
          <select name="state" defaultValue={data.state} className="ml-2 rounded border p-2">
            <option value="all">すべて</option>
            <option value="active">有効</option>
            <option value="inactive">未設定</option>
          </select>
        </label>
        <button className="rounded border px-3 py-2 text-sm" type="submit">
          対応表を検索
        </button>
        <Link href={`/ops/content/${companyId}/migration`} className="text-sm text-primary underline">
          条件を解除
        </Link>
      </form>
      <p className="mb-4 text-sm">
        対応表 {data.total}件 · {data.page} / {data.pages}ページ
      </p>
      <ArticleLegacy companyId={companyId} data={data} />
      <nav aria-label="旧URL対応表のページ" className="my-5 flex flex-wrap gap-5 text-sm text-primary">
        {data.page > 1 && <Link href={href(data.page - 1)}>前の20件</Link>}
        {data.page < data.pages && <Link href={href(data.page + 1)}>次の20件</Link>}
      </nav>
    </>
  );
}
