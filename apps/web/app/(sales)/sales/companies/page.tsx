import { ChevronRight, Info } from "lucide-react";
import Link from "next/link";
import { SharedStateBadges } from "@/components/sales/views";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/label";
import { EmptyState, Muted, PageHeader } from "@/components/ui/page";
import { NativeSelect } from "@/components/ui/select";
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
    <>
      <PageHeader title="企業一覧" />
      <Alert variant="info" className="mb-6">
        <Info />
        <AlertDescription>
          ここに掲載している企業は、運営がホームページを調査して用意した営業候補です。企業からの発注ではなく、成約を約束するものでもありません。
        </AlertDescription>
      </Alert>

      <Card className="mb-6 py-4">
        <CardContent className="px-4">
          <form
            method="get"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end"
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
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit">絞り込む</Button>
              <Link href="/sales/companies" className={buttonVariants({ variant: "ghost" })}>
                条件をクリア
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      {!list.ok ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>一覧を表示できませんでした。</AlertDescription>
        </Alert>
      ) : list.value.length === 0 ? (
        <EmptyState>条件に合う営業候補はありません。</EmptyState>
      ) : (
        <>
          <Muted className="mb-3 block">{list.value.length}件</Muted>
          <ul className="grid gap-3 md:grid-cols-2">
            {list.value.map((c) => (
              <li
                key={c.id}
                className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:border-primary/40"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <Link href={`/sales/companies/${c.id}`} className="font-semibold text-base hover:underline">
                    <strong>{c.name}</strong>
                  </Link>{" "}
                  <SharedStateBadges assignment={c.assignment} suppression={c.suppression} />
                </div>
                <div className="text-muted-foreground text-sm">
                  {[c.prefecture, c.city].filter(Boolean).join(" ") || "地域不明"} ／ {c.industry ?? "業種不明"}
                </div>
                {c.myAssignmentId && (
                  <Link
                    href={`/sales/assignments/${c.myAssignmentId}`}
                    className={buttonVariants({ variant: "outline", size: "sm", className: "mt-1 w-fit" })}
                  >
                    担当案件を開く
                    <ChevronRight />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
