import { DESIGN_LABELS } from "@siteoffer/core";
import type { DesignIndex } from "@/lib/ops/design-index";
import {
  DESIGN_HISTORY_STATES,
  type DesignIndexQuery,
  designIndexHref,
  designIndexParams,
} from "@/lib/ops/design-index-query";
import { DesignFilterForm, DesignFilterLink } from "./design-filter-navigation";

function Fields({ query, omit = [] }: { query: DesignIndexQuery; omit?: string[] }) {
  return (
    <>
      {Array.from(designIndexParams(query))
        .filter(([key]) => !omit.includes(key))
        .map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
    </>
  );
}
export function DesignCompanyPicker({ data, query }: { data: DesignIndex; query: DesignIndexQuery }) {
  const { companies: listing, company } = data;
  return (
    <section aria-label="デザインする案件を探す" className="design-index-picker">
      <DesignFilterForm className="design-index-search" key={query.companyQuery}>
        <Fields query={query} omit={["companyQuery", "companyPage"]} />
        <label>
          会社名・地域から探す
          <input
            type="search"
            name="companyQuery"
            maxLength={120}
            defaultValue={query.companyQuery}
            placeholder="会社名、都道府県、市区町村"
          />
        </label>
        <button type="submit" className="design-button secondary">
          案件を検索
        </button>
      </DesignFilterForm>
      <p className="design-muted">
        検索結果 {listing.total.toLocaleString("ja-JP")}社 · {listing.page} / {listing.pages}ページ
      </p>
      {(company || listing.items.length > 0) && (
        <form method="get" action="/ops/designs" key={`${company?.id}:${query.companyQuery}:${listing.page}`}>
          {query.companyQuery && <input type="hidden" name="companyQuery" value={query.companyQuery} />}
          {listing.page !== 1 && <input type="hidden" name="companyPage" value={listing.page} />}
          <label htmlFor="design-company">開く案件</label>
          <div className="design-inline">
            <select id="design-company" name="company" defaultValue={company?.id ?? listing.items[0]?.id}>
              {company && !listing.items.some((item) => item.id === company.id) && (
                <option value={company.id}>選択中：{company.name}</option>
              )}
              {listing.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.prefecture ? ` / ${item.prefecture}${item.city ?? ""}` : ""}
                </option>
              ))}
            </select>
            <button type="submit" className="design-button secondary">
              開く
            </button>
          </div>
        </form>
      )}
      {listing.total === 0 && (
        <p className="design-muted">条件に合う案件はありません。選択中の制作条件はそのまま編集できます。</p>
      )}
      <nav aria-label="案件検索のページ" className="design-index-pages">
        {listing.page > 1 && (
          <DesignFilterLink href={designIndexHref({ ...query, companyPage: listing.page - 1 })}>
            前の案件
          </DesignFilterLink>
        )}
        {listing.page < listing.pages && (
          <DesignFilterLink href={designIndexHref({ ...query, companyPage: listing.page + 1 })}>
            次の案件
          </DesignFilterLink>
        )}
        {query.companyQuery && (
          <DesignFilterLink href={designIndexHref({ ...query, companyQuery: "", companyPage: 1 })}>
            案件検索を解除
          </DesignFilterLink>
        )}
      </nav>
    </section>
  );
}
export function DesignHistory({ data, query }: { data: DesignIndex; query: DesignIndexQuery }) {
  const { history, selected } = data;
  return (
    <section aria-label="デザインの版を探す" className="design-history-finder">
      <DesignFilterForm className="design-index-search" key={query.historyState}>
        <Fields query={query} omit={["historyState", "historyPage"]} />
        <label>
          版の状態
          <select name="historyState" defaultValue={query.historyState}>
            {DESIGN_HISTORY_STATES.map((state) => (
              <option key={state} value={state}>
                {state === "all" ? "すべて" : DESIGN_LABELS[state]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="design-button secondary">
          履歴を絞り込む
        </button>
      </DesignFilterForm>
      <p className="design-muted">
        履歴 {history.total.toLocaleString("ja-JP")}件 · {history.page} / {history.pages}
        ページ。表示条件を変えても編集中の版は変わりません。
      </p>
      <nav className="design-versions" aria-label="デザインの版">
        <DesignFilterLink className={!selected ? "selected" : ""} href={designIndexHref({ ...query, designId: "new" })}>
          新しい条件<span>元の版を使わず作成</span>
        </DesignFilterLink>
        {selected && !history.items.some((item) => item.id === selected.id) && (
          <DesignFilterLink className="selected" href={designIndexHref(query)}>
            選択中：第{selected.version}版<span>{DESIGN_LABELS[selected.status]}</span>
          </DesignFilterLink>
        )}
        {history.items.map((item) => (
          <DesignFilterLink
            key={item.id}
            className={item.id === selected?.id ? "selected" : ""}
            href={designIndexHref({ ...query, designId: item.id })}
          >
            第{item.version}版<span>{DESIGN_LABELS[item.status]}</span>
          </DesignFilterLink>
        ))}
      </nav>
      {history.total === 0 && <p className="design-muted">条件に合う版はありません。</p>}
      <nav aria-label="デザイン履歴のページ" className="design-index-pages">
        {history.page > 1 && (
          <DesignFilterLink href={designIndexHref({ ...query, historyPage: history.page - 1 })}>
            前の20件
          </DesignFilterLink>
        )}
        {history.page < history.pages && (
          <DesignFilterLink href={designIndexHref({ ...query, historyPage: history.page + 1 })}>
            次の20件
          </DesignFilterLink>
        )}
      </nav>
    </section>
  );
}
