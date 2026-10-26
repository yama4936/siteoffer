import { ArrowRight, Search } from "lucide-react";
import Form from "next/form";
import Link from "next/link";
import { DIRECTORY_ASSIGNMENTS, directoryHref, directoryParams } from "@/lib/sales/directory-query";
import type { CompanyDirectoryPage } from "@/lib/sales/queries";

export function CompanyPagination({
  data,
  base,
  label = "企業一覧のページ",
}: {
  data: CompanyDirectoryPage;
  base: string;
  label?: string;
}) {
  const { filters, pageCount, pageSize } = data;
  return (
    <nav aria-label={label} className="sales-directory-pagination">
      {filters.page > 1 && (
        <Link prefetch={false} href={directoryHref(base, { ...filters, page: filters.page - 1 })}>
          前の{pageSize}件
        </Link>
      )}
      <span>
        {filters.page} / {pageCount} ページ
      </span>
      {filters.page < pageCount && (
        <Link prefetch={false} href={directoryHref(base, { ...filters, page: filters.page + 1 })}>
          次の{pageSize}件
        </Link>
      )}
    </nav>
  );
}

export function CompanyQueue({ data, current }: { data: CompanyDirectoryPage; current: { id: string; name: string } }) {
  const base = `/sales/companies/${current.id}`,
    query = data.filters;
  const hidden = [...directoryParams(query)].filter(([key]) => key !== "q" && key !== "page");
  return (
    <>
      <div className="queue-heading">
        <h1>提案を確認</h1>
        <span>{data.total}</span>
      </div>
      <Form
        key={directoryParams(query).toString()}
        action={base}
        scroll={false}
        className="sales-queue-search"
        aria-label="案件の検索"
      >
        {hidden.map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <label className="queue-search">
          <Search size={15} />
          <input
            name="q"
            defaultValue={query.query}
            maxLength={120}
            aria-label="案件を絞り込む"
            placeholder="企業名・地域・業種"
          />
        </label>
        <button type="submit">検索する</button>
      </Form>
      <nav className="queue-filters sales-queue-filters" aria-label="提案一覧の担当状況">
        {Object.entries(DIRECTORY_ASSIGNMENTS).map(([key, label]) => (
          <Link
            key={key}
            prefetch={false}
            href={directoryHref(base, { ...query, assignment: key as typeof query.assignment, page: 1 })}
            className={query.assignment === key ? "active" : ""}
            aria-current={query.assignment === key ? "page" : undefined}
          >
            {label} {data.counts[key as typeof query.assignment]}
          </Link>
        ))}
      </nav>
      {!data.items.some((c) => c.id === current.id) && (
        <p className="sales-queue-current">
          表示中：<strong>{current.name}</strong>
          <br />
          この検索・ページの外の企業です。
        </p>
      )}
      <nav className="queue-items" aria-label="検索条件に合う提案">
        {data.items.map((c) => (
          <Link
            key={c.id}
            className={`queue-item ${current.id === c.id ? "selected" : ""}`}
            prefetch={false}
            href={directoryHref(`/sales/companies/${c.id}`, query)}
            aria-current={current.id === c.id ? "page" : undefined}
          >
            <strong>{c.name}</strong>
            <small>
              {c.prefecture} / {c.industry ?? "業種未確認"}
            </small>
            <span className="queue-status">
              <i />
              {c.assignment === "mine" ? "自分が担当中" : c.assignment === "none" ? "担当者なし" : "他の営業が担当中"}
            </span>
          </Link>
        ))}
        {!data.items.length && <p className="queue-empty">該当する案件はありません。検索条件を変更できます。</p>}
      </nav>
      <CompanyPagination data={data} base={base} label="提案一覧のページ" />
      <Link prefetch={false} href={directoryHref("/sales/companies", query)} className="queue-all">
        案件一覧を見る <ArrowRight size={15} />
      </Link>
    </>
  );
}
