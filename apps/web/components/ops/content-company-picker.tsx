import type { ContentManagementCompanyPage } from "@siteoffer/core";
import { type ContentIndexQuery, contentIndexHref } from "@/lib/content-index-query";
import { ContentFilterForm, ContentFilterLink } from "./content-filter-navigation";
import { ContentIndexFields } from "./content-index-fields";
export function ContentCompanyPicker({
  data,
  current,
  query,
  base,
}: {
  data: ContentManagementCompanyPage;
  current: { id: string; name: string } | null;
  query: ContentIndexQuery;
  base: string;
}) {
  return (
    <section aria-label="記事を管理する会社" className="w-full rounded-xl border bg-white p-4 xl:w-[420px]">
      <ContentFilterForm action={base} className="flex flex-wrap items-end gap-2" key={data.filters.query}>
        <ContentIndexFields query={query} omit={["companyQuery", "companyPage"]} />
        <label className="min-w-0 flex-1 text-sm">
          会社名・地域から探す
          <input
            type="search"
            name="companyQuery"
            maxLength={120}
            defaultValue={data.filters.query}
            className="mt-2 block w-full rounded border p-2"
            placeholder="会社名、都道府県、市区町村"
          />
        </label>
        <button className="design-button secondary" type="submit">
          企業を検索
        </button>
      </ContentFilterForm>
      <p className="my-3 text-xs text-slate-500">
        検索結果 {data.total.toLocaleString()}社
        {data.total > 0 ? `・${data.filters.page} / ${data.pageCount}ページ` : ""}
      </p>
      {(data.items.length > 0 || current) && (
        <form
          method="get"
          action={base}
          className="flex flex-wrap items-end gap-2"
          key={`${current?.id}:${data.filters.query}:${data.filters.page}`}
        >
          {data.filters.query && <input type="hidden" name="companyQuery" value={data.filters.query} />}
          {data.filters.page !== 1 && <input type="hidden" name="companyPage" value={data.filters.page} />}
          <label className="min-w-0 flex-1 text-sm" htmlFor="content-company">
            更新する会社
          </label>
          <select
            className="w-full rounded border p-2 text-sm"
            id="content-company"
            name="company"
            defaultValue={current?.id ?? data.items[0]?.id}
          >
            {current && !data.items.some((c) => c.id === current.id) && (
              <option value={current.id}>選択中：{current.name}</option>
            )}
            {data.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.prefecture ? ` / ${c.prefecture}${c.city ?? ""}` : ""}
              </option>
            ))}
          </select>
          <button className="design-button secondary" type="submit">
            この会社の記事を開く
          </button>
        </form>
      )}
      {data.total === 0 && <p className="text-sm">条件に合う会社がありません。</p>}
      <nav aria-label="会社検索のページ切り替え" className="mt-3 flex flex-wrap gap-4 text-sm text-blue-700">
        {data.filters.page > 1 && (
          <ContentFilterLink
            href={contentIndexHref(base, { ...query, companies: { ...data.filters, page: data.filters.page - 1 } })}
          >
            前の会社
          </ContentFilterLink>
        )}
        {data.filters.page < data.pageCount && (
          <ContentFilterLink
            href={contentIndexHref(base, { ...query, companies: { ...data.filters, page: data.filters.page + 1 } })}
          >
            次の会社
          </ContentFilterLink>
        )}
        {data.filters.query && (
          <ContentFilterLink href={contentIndexHref(base, { ...query, companies: { query: "", page: 1 } })}>
            会社の検索を解除
          </ContentFilterLink>
        )}
      </nav>
    </section>
  );
}
