"use client";
import { ArrowRight, CheckCheck, CircleAlert, Clock3, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, useTransition } from "react";
import { useMaterialUpdates } from "@/components/materials/updates";
import { readWorkQueue } from "@/lib/client/material-reads";
import { workHref } from "@/lib/ops/work-filters";
import type { WorkGroup } from "@/lib/ops/work-model";
import type { WorkPage } from "@/lib/ops/work-page";

export function WorkQueue({ page, updatedAt }: { page: WorkPage; updatedAt: string }) {
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const [query, setQuery] = useState(page.filters.query);
  const [data, setData] = useState(page);
  const group = page.filters.group;
  function navigate(nextGroup: WorkGroup | "all", nextQuery = query) {
    startNavigation(() =>
      router.push(workHref({ group: nextGroup, query: nextQuery.trim(), cursor: null }), { scroll: false }),
    );
  }
  const [pending, setPending] = useState(false),
    gate = useRef(false);
  const [manualError, setManualError] = useState<{ message: string; checkedAt: number | null } | null>(null);
  const load = useCallback((signal?: AbortSignal) => readWorkQueue(signal, page.filters), [page.filters]);
  const updates = useMaterialUpdates({
    snapshot: data,
    load,
    apply: setData,
    editing: null,
    paused: pending || navigating,
  });
  async function refresh() {
    if (gate.current) return;
    gate.current = true;
    updates.invalidate();
    setPending(true);
    setManualError(null);
    try {
      const r = await load();
      if (r.ok) {
        setData(r.result);
        updates.acknowledge();
      } else setManualError({ message: r.message, checkedAt: updates.checkedAt });
    } catch {
      setManualError({
        message: "仕事の一覧を取得できませんでした。表示が古い可能性があります。再度更新してください。",
        checkedAt: updates.checkedAt,
      });
    } finally {
      gate.current = false;
      setPending(false);
    }
  }
  const { items, groups, matchedTotal, skipped } = data;
  const total = data.total;
  const error = updates.error || (manualError?.checkedAt === updates.checkedAt ? manualError?.message : "");
  const filtered = items;
  const first = items[0];
  const hasFilters = group !== "all" || !!page.filters.query || !!page.filters.cursor;
  const names = new Map(groups.map((g) => [g.key, g.label]));
  const now = updates.checkedAt ?? new Date(updatedAt).getTime();
  const time = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).format(
    new Date(now),
  );
  return (
    <div className="work-queue" aria-busy={navigating}>
      <section className="work-next" aria-labelledby="work-next-title">
        <div className="work-next-symbol">{first ? <ArrowRight size={24} /> : <CheckCheck size={24} />}</div>
        <div>
          <p className="work-eyebrow">
            {first ? "次に進める仕事" : hasFilters ? "表示条件を確認してください" : "確認できる仕事は片付きました"}
          </p>
          <h2 id="work-next-title">
            {first?.title ?? (hasFilters ? "表示条件に合う仕事はありません" : "新しい案件を準備しましょう")}
          </h2>
          <p>
            {first?.reason ??
              (hasFilters
                ? "検索や仕事の種類を変更すると、ほかの対応待ちの仕事を確認できます。"
                : "企業の収集から始められます。各業務画面では作業履歴や処理中の案件も確認できます。")}
          </p>
        </div>
        {!first && hasFilters ? (
          <button
            type="button"
            className="work-primary"
            onClick={() => {
              navigate("all", "");
            }}
          >
            絞り込みを解除 <ArrowRight size={16} />
          </button>
        ) : (
          <Link className="work-primary" href={first?.href ?? "/ops/discovery"}>
            {first?.action ?? "企業を収集する"}
            <ArrowRight size={16} />
          </Link>
        )}
      </section>
      <div className="work-toolbar">
        <div>
          <h2>
            あなたの確認で進む仕事 <span className="work-total">{total}</span>
          </h2>
          <p>公開後の問題・停止対応 → 相談・担当・契約 → 素材などの確認 → 準備の順。同じ優先度は登録の古い順です。</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={pending || navigating} className="work-refresh">
          <RefreshCw size={15} className={pending ? "animate-spin" : ""} />
          {pending ? "更新中" : "最新に更新"}
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-900"
        >
          {error} 前回取得した仕事を表示しています。
        </p>
      )}
      <fieldset className="work-tabs">
        <legend className="sr-only">仕事の種類</legend>
        <button type="button" aria-pressed={group === "all"} onClick={() => navigate("all")}>
          すべて <b>{total}</b>
        </button>
        {groups
          .filter((g) => g.count > 0 || g.key === group)
          .map((g) => (
            <button key={g.key} type="button" aria-pressed={group === g.key} onClick={() => navigate(g.key)}>
              {g.label} <b>{g.count}</b>
            </button>
          ))}
      </fieldset>
      <search className="work-filter" aria-label="すべての仕事を検索">
        <label>
          <Search size={16} />
          <input
            aria-label="企業名・確認内容を全件から検索"
            placeholder="企業名・確認内容を全件から検索"
            maxLength={200}
            type="search"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                navigate(group);
              }
            }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="button" className="work-refresh" onClick={() => navigate(group)} disabled={navigating}>
          仕事を検索
        </button>
        {hasFilters && (
          <button type="button" className="work-refresh" onClick={() => navigate("all", "")}>
            条件をクリア
          </button>
        )}
        <span aria-live="polite">{navigating ? "仕事を検索中…" : `${time} 更新 · 30秒ごとに自動更新`}</span>
      </search>
      {query.trim() !== page.filters.query && (
        <p role="status" className="work-footnote">
          検索語を変更しています。「仕事を検索」で一覧に反映します。
        </p>
      )}
      <section className="work-list" aria-label="対応する仕事">
        {filtered.length === 0 ? (
          <div className="work-empty">
            <CheckCheck size={25} />
            <h3>{!hasFilters && total === 0 ? "現在、対応待ちの仕事はありません" : "該当する仕事はありません"}</h3>
            <p>{query ? "検索条件を変更してください。" : "ほかの種類の仕事や、各業務画面も確認できます。"}</p>
            {hasFilters && (
              <button
                type="button"
                onClick={() => {
                  navigate("all", "");
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
              <article
                key={`${item.group}:${item.id}`}
                className="work-row"
                data-priority={item.priority}
                data-work-group={item.group}
                data-work-id={item.id}
              >
                <div className="work-row-icon">
                  {item.priority === 0 ? <CircleAlert size={19} /> : <Clock3 size={19} />}
                </div>
                <div className="work-row-content">
                  <div className="work-row-meta">
                    <span>{names.get(item.group)}</span>
                    {item.priority === 0 && <b>{item.attentionLabel ?? "停止中"}</b>}
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
      <div className="work-pagination">
        <p className="work-footnote" role="status">
          {items.length ? `${skipped + 1}〜${skipped + items.length}件` : "0件"}を表示 / 対象 {matchedTotal}件。
          承認・契約・公開は、それぞれの画面で内容を確認して行います。
        </p>
        <nav aria-label="仕事のページ">
          {page.filters.cursor && (
            <Link className="work-refresh" href={workHref({ ...page.filters, cursor: null })} scroll={false}>
              先頭の20件
            </Link>
          )}
          {data.nextCursor && (
            <Link className="work-refresh" href={workHref({ ...page.filters, cursor: data.nextCursor })} scroll={false}>
              次の20件 <ArrowRight size={14} />
            </Link>
          )}
        </nav>
      </div>
    </div>
  );
}
