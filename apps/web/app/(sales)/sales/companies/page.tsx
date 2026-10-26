import { Search } from "lucide-react";
import Form from "next/form";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CompanyDirectory } from "@/components/sales/directory";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { getDb } from "@/lib/db";
import { directoryParams, parseDirectoryQuery } from "@/lib/sales/directory-query";
import { listSellableCompanies } from "@/lib/sales/queries";
import { requireUser } from "@/lib/session";

export const metadata = { title: "企業一覧 | SiteOffer" };
const selected = (values: string[], value: string) => [...new Set([...values, value].filter(Boolean))];
export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("sales");
  const query = parseDirectoryQuery(await searchParams);
  if (!query) notFound();
  const result = await listSellableCompanies(getDb(), user.actor, query);
  if (!result.ok)
    return (
      <Alert variant="destructive">
        <AlertDescription>一覧を表示できませんでした。</AlertDescription>
      </Alert>
    );
  const data = result.value,
    filter = data.filters,
    options = data.options;
  const cities = selected(
    options.cities.filter((c) => !filter.prefecture || c.prefecture === filter.prefecture).map((c) => c.city),
    filter.city,
  );
  return (
    <CompanyDirectory
      data={data}
      filters={
        <Form
          action="/sales/companies"
          key={directoryParams(filter).toString()}
          className="sales-directory-form"
          aria-label="絞り込み"
          scroll={false}
        >
          <input type="hidden" name="assignment" value={filter.assignment} />
          <div className="sales-directory-search-row">
            <label className="sales-list-search">
              <Search size={17} />
              <input
                name="q"
                aria-label="企業一覧を検索"
                defaultValue={filter.query}
                maxLength={120}
                placeholder="企業名・地域・業種で全候補を検索"
              />
            </label>
            <Button type="submit">検索する</Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end">
            <Field label="都道府県" htmlFor="filter-prefecture">
              <NativeSelect id="filter-prefecture" name="prefecture" defaultValue={filter.prefecture}>
                <option value="">すべて</option>
                {selected(options.prefectures, filter.prefecture).map((p) => (
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
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="業種" htmlFor="filter-industry">
              <NativeSelect id="filter-industry" name="industry" defaultValue={filter.industry}>
                <option value="">すべて</option>
                {selected(options.industries, filter.industry).map((i) => (
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
              <Link prefetch={false} href="/sales/companies" className={buttonVariants({ variant: "ghost" })}>
                条件をクリア
              </Link>
            </div>
          </div>
        </Form>
      }
    />
  );
}
