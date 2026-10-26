import { ArrowRight, BriefcaseBusiness, Building2, CheckCircle2, Search } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { DIRECTORY_ASSIGNMENTS, directoryHref } from "@/lib/sales/directory-query";
import type { CompanyDirectoryPage } from "@/lib/sales/queries";
import { CompanyPagination } from "./company-directory-parts";
import { SharedStateBadges } from "./views";

export function CompanyDirectory({ data, filters }: { data: CompanyDirectoryPage; filters: ReactNode }) {
  const { items, counts, total, pageSize, filters: query } = data;
  return (
    <div className="sales-directory">
      <header className="sales-page-heading">
        <div>
          <span className="sales-eyebrow">SALES WORKSPACE</span>
          <h1>企業・案件</h1>
          <p>提案を見比べて、次の商談につなげましょう。</p>
        </div>
        <Link className="review-outline" href="/sales/assignments">
          担当案件を見る <ArrowRight size={16} />
        </Link>
      </header>
      <div className="sales-metrics">
        {[
          { label: "営業候補", value: counts.all, icon: Building2 },
          { label: "担当者なし", value: counts.none, icon: CheckCircle2 },
          {
            label: "自分が担当中",
            value: counts.mine,
            icon: BriefcaseBusiness,
          },
        ].map((m) => (
          <div key={m.label}>
            <span className="metric-icon">
              <m.icon size={21} />
            </span>
            <div>
              <small>{m.label}</small>
              <strong>
                {m.value}
                <span>件</span>
              </strong>
            </div>
          </div>
        ))}
      </div>
      <div className="sales-directory-surface">
        <div className="sales-list-toolbar">
          <nav className="review-tabs sales-directory-tabs" aria-label="担当状況で絞り込む">
            {Object.entries(DIRECTORY_ASSIGNMENTS).map(([id, label]) => (
              <Link
                key={id}
                prefetch={false}
                className={query.assignment === id ? "active" : ""}
                aria-current={query.assignment === id ? "page" : undefined}
                href={directoryHref("/sales/companies", {
                  ...query,
                  assignment: id as typeof query.assignment,
                  page: 1,
                })}
              >
                {label} <span>{counts[id as typeof query.assignment]}</span>
              </Link>
            ))}
          </nav>
        </div>
        <div className="sales-filters">{filters}</div>
        <div className="sales-list-caption">
          <strong>
            {total} 件中 {total ? (query.page - 1) * pageSize + 1 : 0}–{Math.min(query.page * pageSize, total)} 件を表示
          </strong>
          <span>件数は検索条件に合う全候補の集計です</span>
        </div>
        {items.length ? (
          <div className="sales-company-table">
            <div className="sales-company-table-head">
              <span>企業・所在地</span>
              <span>業種</span>
              <span>診断の総合点</span>
              <span>担当状況</span>
              <span>提案</span>
            </div>
            {items.map((c) => (
              <div className="sales-company-row" key={c.id}>
                <div className="sales-company-name">
                  <span className="company-monogram">{c.name.replace(/株式会社|有限会社/g, "").slice(0, 1)}</span>
                  <div>
                    <Link prefetch={false} href={directoryHref(`/sales/companies/${c.id}`, query)}>
                      {c.name}
                    </Link>
                    <small>{[c.prefecture, c.city].filter(Boolean).join(" ") || "所在地未確認"}</small>
                  </div>
                </div>
                <div className="company-industry">{c.industry ?? "未確認"}</div>
                <div className="company-score">
                  <strong>{c.totalScore ?? "—"}</strong>
                  <small>{c.totalScore === null ? "未評価" : c.scoreConfirmed === false ? "未確定" : "/ 100"}</small>
                </div>
                <div className="company-assignment">
                  <SharedStateBadges assignment={c.assignment} suppression={c.suppression} />
                  {c.myAssignmentId && (
                    <Link href={`/sales/assignments/${c.myAssignmentId}`} className="assignment-shortcut">
                      活動記録へ
                    </Link>
                  )}
                </div>
                <Link
                  prefetch={false}
                  href={directoryHref(`/sales/companies/${c.id}`, query)}
                  className="sales-open-proposal"
                >
                  提案を見る
                  <ArrowRight size={16} />
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <div className="sales-list-empty">
            <Search size={28} />
            <h2>条件に合う企業はありません</h2>
            <p>検索語や絞り込み条件を変更してください。</p>
          </div>
        )}
        <CompanyPagination data={data} base="/sales/companies" />
      </div>
      <p className="sales-candidate-note">
        掲載企業は、運営が調査して用意した営業候補です。企業からの発注や成約を保証するものではありません。
        <Link href="/sources" className="inline-flex min-h-11 items-center underline underline-offset-4">
          企業情報の出典を確認
        </Link>
      </p>
    </div>
  );
}
