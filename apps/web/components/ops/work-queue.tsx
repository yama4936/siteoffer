"use client";
import { ArrowRight, CheckCheck, CircleAlert, Clock3, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { WorkGroup, WorkItem } from "@/lib/ops/work-queue";

export function WorkQueue({
  items,
  groups,
  total,
  perGroup,
  updatedAt,
}: {
  items: WorkItem[];
  groups: { key: WorkGroup; label: string; href: string; count: number }[];
  total: number;
  perGroup: number;
  updatedAt: string;
}) {
  const [group, setGroup] = useState<WorkGroup | "all">("all");
  const [query, setQuery] = useState("");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName ?? "")
      )
        startTransition(() => router.refresh());
    }, 30000);
    return () => clearInterval(timer);
  }, [router]);
  const filtered = items.filter(
    (item) =>
      (group === "all" || item.group === group) &&
      `${item.title} ${item.reason}`.toLocaleLowerCase("ja").includes(query.trim().toLocaleLowerCase("ja")),
  );
  const first = items[0];
  const names = new Map(groups.map((g) => [g.key, g.label]));
  const count = group === "all" ? total : (groups.find((g) => g.key === group)?.count ?? 0);
  const now = new Date(updatedAt).getTime();
  const time = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).format(
    new Date(updatedAt),
  );
  return (
    <div className="work-queue">
      <section className="work-next" aria-labelledby="work-next-title">
        <div className="work-next-symbol">{first ? <ArrowRight size={24} /> : <CheckCheck size={24} />}</div>
        <div>
          <p className="work-eyebrow">{first ? "次に進める仕事" : "確認できる仕事は片付きました"}</p>
          <h2 id="work-next-title">{first?.title ?? "新しい案件を準備しましょう"}</h2>
          <p>{first?.reason ?? "企業の収集から始められます。各業務画面では作業履歴や処理中の案件も確認できます。"}</p>
        </div>
        <Link className="work-primary" href={first?.href ?? "/ops/discovery"}>
          {first?.action ?? "企業を収集する"}
          <ArrowRight size={16} />
        </Link>
      </section>
      <div className="work-toolbar">
        <div>
          <h2>
            あなたの確認で進む仕事 <span className="work-total">{total}</span>
          </h2>
          <p>停止対応 → 相談・担当・契約 → 確認 → 準備の順。同じ優先度は登録の古い順です。</p>
        </div>
        <button
          type="button"
          onClick={() => startTransition(() => router.refresh())}
          disabled={pending}
          className="work-refresh"
        >
          <RefreshCw size={15} className={pending ? "animate-spin" : ""} />
          {pending ? "更新中" : "最新に更新"}
        </button>
      </div>
      <fieldset className="work-tabs">
        <legend className="sr-only">仕事の種類</legend>
        <button type="button" aria-pressed={group === "all"} onClick={() => setGroup("all")}>
          すべて <b>{total}</b>
        </button>
        {groups
          .filter((g) => g.count > 0 || g.key === group)
          .map((g) => (
            <button key={g.key} type="button" aria-pressed={group === g.key} onClick={() => setGroup(g.key)}>
              {g.label} <b>{g.count}</b>
            </button>
          ))}
      </fieldset>
      <div className="work-filter">
        <label>
          <Search size={16} />
          <input
            aria-label="表示中の仕事を検索"
            placeholder="表示中の企業名・確認内容を検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span aria-live="polite">{time} 更新 · 30秒ごとに自動更新</span>
      </div>
      <section className="work-list" aria-label="対応する仕事">
        {filtered.length === 0 ? (
          <div className="work-empty">
            <CheckCheck size={25} />
            <h3>{total === 0 ? "現在、対応待ちの仕事はありません" : "該当する仕事はありません"}</h3>
            <p>{query ? "検索条件を変更してください。" : "ほかの種類の仕事や、各業務画面も確認できます。"}</p>
            {total > 0 && (
              <button
                type="button"
                onClick={() => {
                  setGroup("all");
                  setQuery("");
                }}
              >
                絞り込みを解除
              </button>
            )}
          </div>
        ) : (
          filtered.map((item) => {
            const age = Math.max(
              0,
              Math.floor((now + 9 * 3600000) / 86400000) -
                Math.floor((new Date(item.since).getTime() + 9 * 3600000) / 86400000),
            );
            return (
              <article key={`${item.group}:${item.id}`} className="work-row" data-priority={item.priority}>
                <div className="work-row-icon">
                  {item.priority === 0 ? <CircleAlert size={19} /> : <Clock3 size={19} />}
                </div>
                <div className="work-row-content">
                  <div className="work-row-meta">
                    <span>{names.get(item.group)}</span>
                    {item.priority === 0 && <b>停止中</b>}
                    <span>{age === 0 ? "本日登録・更新" : `${age}日前に登録・更新`}</span>
                  </div>
                  <h3>
                    <Link href={item.href}>{item.title}</Link>
                  </h3>
                  <p>{item.reason}</p>
                </div>
                <Link className="work-row-action" href={item.href}>
                  {item.action}
                  <ArrowRight size={15} />
                </Link>
              </article>
            );
          })
        )}
      </section>
      <p className="work-footnote">
        {filtered.length}件を表示 / 対象 {count}件。各種類の上位{perGroup}
        件を表示しています。承認・契約・公開は、それぞれの画面で内容を確認して行います。
      </p>
      {groups.some((g) => g.count > perGroup) && (
        <div className="work-more">
          {groups
            .filter((g) => g.count > perGroup)
            .map((g) => (
              <Link key={g.key} href={g.href}>
                {g.label}の一覧を開く（{g.count}件待ち） <ArrowRight size={14} />
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}
