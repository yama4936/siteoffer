import Link from "next/link";
import { ContractLedgerClear } from "@/components/ops/contract-ledger-clear";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Stat } from "@/components/ui/page";
import { NativeSelect } from "@/components/ui/select";
import type { ContractsLedger } from "@/lib/ops/contract-ledger";
import {
  CONTRACT_LEDGER_REWARD,
  CONTRACT_LEDGER_SORT,
  CONTRACT_LEDGER_STATUS,
  contractLedgerHref,
} from "@/lib/ops/contract-ledger-filters";

type LedgerNavigation = Pick<
  ContractsLedger,
  "filters" | "total" | "pending" | "unpaid" | "page" | "pages" | "pageSize"
>;

export function ContractLedgerControls({ ledger }: { ledger: LedgerNavigation }) {
  const { filters } = ledger;
  return (
    <>
      <section className="grid grid-cols-3 gap-2 sm:gap-3" aria-label="この検索結果の状況">
        <Stat
          className="min-w-0 break-words p-3 sm:p-4"
          label="該当する契約"
          value={`${ledger.total.toLocaleString("ja-JP")}件`}
        />
        <Stat
          className="min-w-0 break-words p-3 sm:p-4"
          label="契約の確認待ち"
          value={`${ledger.pending.toLocaleString("ja-JP")}件`}
        />
        <Stat
          className="min-w-0 break-words p-3 sm:p-4"
          label="報酬の支払待ち"
          value={`${ledger.unpaid.toLocaleString("ja-JP")}件`}
        />
      </section>
      <search aria-label="契約を全件から検索">
        <form
          key={contractLedgerHref(filters)}
          method="get"
          action="/ops/contracts#contract-list"
          className="space-y-3 rounded-xl border bg-card p-4"
        >
          <Field label="企業名・営業担当・契約番号" htmlFor="contract-query">
            <Input
              id="contract-query"
              name="q"
              defaultValue={filters.q}
              maxLength={200}
              placeholder="過去の契約も含めて検索"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="契約の状態" htmlFor="contract-status">
              <NativeSelect id="contract-status" name="status" defaultValue={filters.status}>
                {Object.entries(CONTRACT_LEDGER_STATUS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="報酬の状態" htmlFor="contract-reward">
              <NativeSelect id="contract-reward" name="reward" defaultValue={filters.reward}>
                {Object.entries(CONTRACT_LEDGER_REWARD).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="col-span-2 sm:col-span-1">
              <Field label="並び順" htmlFor="contract-sort">
                <NativeSelect id="contract-sort" name="sort" defaultValue={filters.sort}>
                  {Object.entries(CONTRACT_LEDGER_SORT).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm">
              全件から検索
            </Button>
            <ContractLedgerClear />
          </div>
        </form>
      </search>
      <ContractLedgerPagination ledger={ledger} />
    </>
  );
}

export function ContractLedgerPagination({ ledger, bottom = false }: { ledger: LedgerNavigation; bottom?: boolean }) {
  const { total, page, pages, pageSize, filters } = ledger;
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(page * pageSize, total);
  const style = buttonVariants({ size: "sm", variant: "outline" });
  return (
    <nav
      aria-label={`契約一覧のページ${bottom ? "（下部）" : ""}`}
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <p role="status" className="text-sm text-muted-foreground">
        {from.toLocaleString("ja-JP")}〜{to.toLocaleString("ja-JP")}件 / {total.toLocaleString("ja-JP")}件
        <span className="ml-2">
          {page.toLocaleString("ja-JP")} / {pages.toLocaleString("ja-JP")}ページ
        </span>
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link className={style} href={contractLedgerHref({ ...filters, page: page - 1 })} rel="prev">
            前の25件
          </Link>
        ) : (
          <span className={`${style} opacity-50`} aria-disabled="true">
            前の25件
          </span>
        )}
        {page < pages ? (
          <Link className={style} href={contractLedgerHref({ ...filters, page: page + 1 })} rel="next">
            次の25件
          </Link>
        ) : (
          <span className={`${style} opacity-50`} aria-disabled="true">
            次の25件
          </span>
        )}
      </div>
    </nav>
  );
}
