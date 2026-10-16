"use client";
import { ArrowRight, BriefcaseBusiness, Building2, CheckCircle2, Search } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import type { CompanyListItem } from "@/lib/sales/queries";
import { SharedStateBadges } from "./views";

export function CompanyDirectory({
  items,
  filters,
  initialQuery,
}: {
  items: CompanyListItem[];
  filters: ReactNode;
  initialQuery: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [tab, setTab] = useState("all");
  const visible = items.filter(
    (c) =>
      (tab === "all" || c.assignment === tab) &&
      `${c.name} ${c.prefecture} ${c.city} ${c.industry}`.toLowerCase().includes(query.toLowerCase()),
  );
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
          { label: "営業候補", value: items.length, icon: Building2 },
          { label: "担当者なし", value: items.filter((c) => c.assignment === "none").length, icon: CheckCircle2 },
          {
            label: "自分が担当中",
            value: items.filter((c) => c.assignment === "mine").length,
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
          <div className="review-tabs">
            {[
              ["all", "すべて"],
              ["none", "担当者なし"],
              ["mine", "自分の担当"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={tab === id ? "active" : ""}
                aria-pressed={tab === id}
                onClick={() => setTab(id!)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="sales-list-search">
            <Search size={17} />
            <input
              aria-label="企業一覧を検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="企業名・地域・業種で検索"
            />
          </label>
        </div>
        <div className="sales-filters">{filters}</div>
        <div className="sales-list-caption">
          <strong>{visible.length} 件の企業</strong>
          <span>地域・業種・診断結果から確認できます</span>
        </div>
        {visible.length ? (
          <div className="sales-company-table">
            <div className="sales-company-table-head">
              <span>企業・所在地</span>
              <span>業種</span>
              <span>診断の総合点</span>
              <span>担当状況</span>
              <span>提案</span>
            </div>
            {visible.map((c) => (
              <div className="sales-company-row" key={c.id}>
                <div className="sales-company-name">
                  <span className="company-monogram">{c.name.replace(/株式会社|有限会社/g, "").slice(0, 1)}</span>
                  <div>
                    <Link href={`/sales/companies/${c.id}`}>{c.name}</Link>
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
                <Link href={`/sales/companies/${c.id}`} className="sales-open-proposal">
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
      </div>
      <p className="sales-candidate-note">
        掲載企業は、運営が調査して用意した営業候補です。企業からの発注や成約を保証するものではありません。
      </p>
    </div>
  );
}
