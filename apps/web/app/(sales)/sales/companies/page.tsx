import Link from "next/link";
import { SharedStateBadges } from "@/components/sales/views";
import { getDb } from "@/lib/db";
import { getCompanyFilterOptions, listSellableCompanies } from "@/lib/sales/queries";
import { requireUser } from "@/lib/session";

export const metadata = { title: "企業一覧 | SiteOffer" };

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * 企業一覧（16章）。営業可能な企業だけを表示する。
 * 企業候補は運営側の自動収集で用意するため、営業ユーザーがURLを登録する入口は作らない（F-05）。
 */
export default async function CompaniesPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser("sales");
  const sp = await searchParams;
  const filter = { prefecture: one(sp.prefecture), city: one(sp.city), industry: one(sp.industry) };
  const db = getDb();
  const [list, options] = await Promise.all([
    listSellableCompanies(db, user.actor, filter),
    getCompanyFilterOptions(db),
  ]);
  const cities = options.cities.filter((c) => !filter.prefecture || c.prefecture === filter.prefecture);

  return (
    <main>
      <h1>企業一覧</h1>
      <p className="disclaimer">
        ここに掲載している企業は、運営がホームページを調査して用意した営業候補です。企業からの発注ではなく、成約を約束するものでもありません。
      </p>

      <form method="get" className="filters" aria-label="絞り込み">
        <label>
          都道府県
          <select name="prefecture" defaultValue={filter.prefecture}>
            <option value="">すべて</option>
            {options.prefectures.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          市区町村
          <select name="city" defaultValue={filter.city}>
            <option value="">すべて</option>
            {cities.map((c) => (
              <option key={`${c.prefecture}/${c.city}`} value={c.city}>
                {filter.prefecture ? c.city : `${c.prefecture ?? ""} ${c.city}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          業種
          <select name="industry" defaultValue={filter.industry}>
            <option value="">すべて</option>
            {options.industries.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">絞り込む</button>
        <Link href="/sales/companies">条件をクリア</Link>
      </form>

      {!list.ok ? (
        <p role="alert">一覧を表示できませんでした。</p>
      ) : list.value.length === 0 ? (
        <p>条件に合う営業候補はありません。</p>
      ) : (
        <>
          <p className="sub">{list.value.length}件</p>
          <ul className="cards">
            {list.value.map((c) => (
              <li key={c.id}>
                <div>
                  <Link href={`/sales/companies/${c.id}`}>
                    <strong>{c.name}</strong>
                  </Link>{" "}
                  <SharedStateBadges assignment={c.assignment} suppression={c.suppression} />
                </div>
                <div className="sub">
                  {[c.prefecture, c.city].filter(Boolean).join(" ") || "地域不明"} ／ {c.industry ?? "業種不明"}
                </div>
                {c.myAssignmentId && <Link href={`/sales/assignments/${c.myAssignmentId}`}>担当案件を開く</Link>}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
