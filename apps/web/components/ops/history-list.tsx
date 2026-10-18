import Link from "next/link";
import { EmptyState } from "@/components/ui/page";
import { fmtDate } from "@/lib/ops/format";
import type { HistoryPage } from "@/lib/ops/history";
import { HISTORY_TARGETS, historyActionLabel, historyTargetLink } from "@/lib/ops/history-presentation";
import { HISTORY_ACTORS, historyHref, historyParams } from "@/lib/ops/history-query";

export function HistoryList({ data, compact = false }: { data: HistoryPage; compact?: boolean }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {data.total.toLocaleString("ja-JP")}件
        {data.total > 0
          ? `中 ${(data.query.page - 1) * 20 + 1}〜${(data.query.page - 1) * 20 + data.items.length}件`
          : ""}{" "}
        · 新しい順
      </p>
      <p className="text-xs text-muted-foreground">
        担当者名・企業名は現在の登録内容です。操作時点の値は、その操作に保存された項目で確認してください。
      </p>
      {!data.items.length ? (
        <EmptyState>条件に一致する操作はありません。検索語や期間を変更してください。</EmptyState>
      ) : (
        <ol className="divide-y rounded-xl border bg-white">
          {data.items.map((item) => {
            const target = Object.hasOwn(HISTORY_TARGETS, item.targetType)
              ? HISTORY_TARGETS[item.targetType]
              : "対象の記録";
            const kind = Object.hasOwn(HISTORY_ACTORS, item.actorKind) ? HISTORY_ACTORS[item.actorKind] : "不明な主体";
            const recordHref = historyTargetLink(item.targetType, item.targetId, item.companyName);
            return (
              <li key={item.id} className="grid min-w-0 gap-3 p-4 lg:grid-cols-[11rem_1fr_auto]">
                <div className="text-xs leading-6 text-muted-foreground">
                  <time dateTime={item.createdAt}>{fmtDate(item.createdAt)}</time>
                  <p className="break-words">
                    {kind}
                    {item.actorName ? ` · ${item.actorName}` : ""}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="font-medium">{historyActionLabel(item.action)}</p>
                  <p className="mt-1 text-sm break-words">
                    {target}
                    {item.companyName ? ` · ${item.companyName}` : ""}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{item.action}</p>
                  {!compact && (
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      対象ID：{item.targetId}
                      {item.targetTruncated ? "…（表示を省略）" : ""}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-start gap-3 text-sm">
                  <Link
                    className="text-primary underline"
                    href={`/ops/history/${item.id}?${historyParams(data.query)}`}
                  >
                    変更内容を確認
                  </Link>
                  {recordHref && (
                    <Link className="text-primary underline" href={recordHref}>
                      対象を開く
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {!compact && (
        <nav aria-label="操作履歴のページ" className="flex flex-wrap items-center gap-4 text-sm">
          {data.query.page > 1 && (
            <Link href={historyHref(data.query, { page: data.query.page - 1 })} className="text-primary underline">
              前の20件
            </Link>
          )}
          <span>
            {data.query.page} / {data.pages}ページ
          </span>
          {data.query.page < data.pages && (
            <Link href={historyHref(data.query, { page: data.query.page + 1 })} className="text-primary underline">
              次の20件
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
