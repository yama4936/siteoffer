import Link from "next/link";
import { CompanyDirectory } from "@/components/sales/directory";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { getDb } from "@/lib/db";
import { getCompanyFilterOptions, listSellableCompanies, parseCompanySort } from "@/lib/sales/queries";
import { requireUser } from "@/lib/session";

export const metadata = { title: "企業一覧 | SiteOffer" };

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** 一覧での総合点の表示。点数のない企業は低評価に見せない */
const _scoreLabel = (c: { totalScore: string | null; scoreConfirmed: boolean | null }) =>
  c.totalScore === null ? "総合点なし" : `総合点 ${c.totalScore}${c.scoreConfirmed === false ? "（未確定）" : ""}`;

/**
 * 企業一覧（16章）。営業可能な企業だけを表示する。
 * 企業候補は運営側の自動収集で用意するため、営業ユーザーがURLを登録する入口は作らない（F-05）。
 */
export default async function CompaniesPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser("sales");
  const sp = await searchParams;
  const filter = {
    prefecture: one(sp.prefecture),
    city: one(sp.city),
    industry: one(sp.industry),
    sort: parseCompanySort(one(sp.sort)),
  };
  const db = getDb();
  const [list, options] = await Promise.all([
    listSellableCompanies(db, user.actor, filter),
    getCompanyFilterOptions(db),
  ]);
  const cities = options.cities.filter((c) => !filter.prefecture || c.prefecture === filter.prefecture);

  return !list.ok ? (
    <Alert variant="destructive">
      <AlertDescription>一覧を表示できませんでした。</AlertDescription>
    </Alert>
  ) : (
    <CompanyDirectory
      items={list.value}
      initialQuery={one(sp.q)}
      filters={
        <form
          method="get"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end"
          aria-label="絞り込み"
        >
          <Field label="都道府県" htmlFor="filter-prefecture">
            <NativeSelect id="filter-prefecture" name="prefecture" defaultValue={filter.prefecture}>
              <option value="">すべて</option>
              {options.prefectures.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="市区町村" htmlFor="filter-city">
            <NativeSelect id="filter-city" name="city" defaultValue={filter.city}>
              <option value="">すべて</option>
              {cities.map((c) => (
                <option key={`${c.prefecture}/${c.city}`} value={c.city}>
                  {filter.prefecture ? c.city : `${c.prefecture ?? ""} ${c.city}`}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="業種" htmlFor="filter-industry">
            <NativeSelect id="filter-industry" name="industry" defaultValue={filter.industry}>
              <option value="">すべて</option>
              {options.industries.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="並び順" htmlFor="filter-sort">
            <NativeSelect id="filter-sort" name="sort" defaultValue={filter.sort}>
              <option value="score_asc">評価点の低い順</option>
              <option value="score_desc">評価点の高い順</option>
              <option value="region">地域順</option>
            </NativeSelect>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit">絞り込む</Button>
            <Link href="/sales/companies" className={buttonVariants({ variant: "ghost" })}>
              条件をクリア
            </Link>
          </div>
        </form>
      }
    />
  );
}
