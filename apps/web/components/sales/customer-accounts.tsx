// 営業の企業詳細：顧客の管理画面のアカウントと役割（表示だけ。変更は運営が行う・T23の(d)）
import Link from "next/link";
import {
  CUSTOMER_ROLE_DESCRIPTIONS,
  CUSTOMER_ROLE_LABELS,
  customerAccountRows,
  type SalesCustomerAccount,
} from "@/lib/sales/customer-accounts";

export type CustomerAccountsData = { status: "ok"; access: SalesCustomerAccount[] } | { status: "error" };

export function CustomerAccounts({ data, now }: { data: CustomerAccountsData; now: number }) {
  const rows = data.status === "ok" ? customerAccountRows(data.access, now) : [];
  return (
    <section className="sales-customer-accounts" aria-labelledby="sales-customer-accounts-title">
      <h3 id="sales-customer-accounts-title">顧客の管理画面のアカウント</h3>
      {data.status === "error" ? (
        <p className="text-sm text-muted-foreground">
          顧客アカウントを確認できませんでした。時間をおいて開き直してください。
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">契約完了後、運営が顧客の管理者アカウントを発行します。</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={r.id} className={r.stopped ? "sales-customer-account stopped" : "sales-customer-account"}>
              <span className="break-all">{r.email}</span>
              <span className="sales-customer-role">{r.role}</span>
              <span className="sales-customer-state">{r.state}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="sales-customer-roles">
        {(["admin", "editor"] as const).map((role) => (
          <div key={role}>
            <dt>{CUSTOMER_ROLE_LABELS[role]}</dt>
            <dd>{CUSTOMER_ROLE_DESCRIPTIONS[role]}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted-foreground">
        営業画面では表示だけです。アカウントの追加・役割の変更・停止が必要な場合は、
        <Link href="/sales/consultations" className="text-primary underline">
          運営への相談
        </Link>
        から依頼してください。
      </p>
    </section>
  );
}
