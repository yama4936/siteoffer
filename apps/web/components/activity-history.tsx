"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  type ActivityHistoryFilters,
  type ActivityHistoryPage,
  activityHistoryParams,
  validActivityHistoryPage,
} from "@/lib/activity-history-types";
import { PrivateReadFailure, readPrivateJson } from "@/lib/client/private-json";
import { ACTIVITY_KINDS, activityKindLabel, formatDateTime } from "@/lib/sales/labels";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/select";

/** History reads never replace the adjacent activity editor or use its mutation queue. */
export function ActivityHistory({
  initial,
  audience = "sales",
}: {
  initial: ActivityHistoryPage;
  audience?: "sales" | "ops";
}) {
  const assignmentId = initial.assignment.id,
    id = useId();
  const [data, setData] = useState<ActivityHistoryPage | null>(initial),
    [filters, setFilters] = useState(initial.filters),
    [loading, setLoading] = useState(false),
    [retrying, setRetrying] = useState(false),
    [error, setError] = useState("");
  const request = useRef<AbortController | null>(null),
    ticket = useRef(0),
    attempted = useRef(initial.filters),
    lastInitial = useRef(initial);
  const load = useCallback(
    async (next: ActivityHistoryFilters) => {
      const current = ++ticket.current;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      attempted.current = next;
      setLoading(true);
      setRetrying(false);
      setError("");
      setData(null);
      try {
        const { response, body } = await readPrivateJson(
          `/activity-history/${assignmentId}?${activityHistoryParams(next)}`,
          {
            signal: controller.signal,
            timeoutMs: 15000,
            retryOnce: true,
            onRetry: () => {
              if (ticket.current === current) setRetrying(true);
            },
          },
        );
        if (!response.ok)
          throw new PrivateReadFailure(
            response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : "network",
            false,
          );
        const result = body && typeof body === "object" ? (body as { ok?: unknown; result?: unknown }) : null;
        if (result?.ok !== true || !validActivityHistoryPage(result.result, assignmentId))
          throw new PrivateReadFailure("invalid_response", false);
        if (ticket.current !== current || controller.signal.aborted) return;
        attempted.current = result.result.filters;
        setData(result.result);
      } catch (e) {
        if (ticket.current !== current || controller.signal.aborted) return;
        setError(
          e instanceof PrivateReadFailure && (e.code === "forbidden" || e.code === "not_found")
            ? "案件の利用権限を確認してください。入力中の活動メモは残っています。"
            : "活動履歴を読み取れませんでした。入力中のメモはそのままです。再読み込みしてください。",
        );
      } finally {
        if (ticket.current === current && !controller.signal.aborted) {
          setLoading(false);
          setRetrying(false);
        }
      }
    },
    [assignmentId],
  );
  useEffect(
    () => () => {
      ticket.current++;
      request.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (lastInitial.current === initial) return;
    lastInitial.current = initial;
    void load(attempted.current);
  }, [initial, load]);
  return (
    <section
      aria-label="活動履歴の検索と一覧"
      className="min-w-0 max-w-5xl space-y-4 [&_button]:min-h-11 [&_input]:min-h-11 [&_select]:min-h-11"
    >
      <search aria-label="活動履歴を検索">
        <form
          method="get"
          action={
            audience === "sales" ? `/sales/assignments/${assignmentId}` : `/ops/assignments/${assignmentId}/history`
          }
          data-activity-history={assignmentId}
          onSubmit={(e) => {
            e.preventDefault();
            void load({ ...filters, page: 1 });
          }}
          className="grid min-w-0 gap-3 sm:grid-cols-2"
        >
          <label htmlFor={`${id}-query`} className="min-w-0 text-sm">
            メモのキーワード
            <Input
              id={`${id}-query`}
              name="q"
              type="search"
              maxLength={200}
              value={filters.query}
              onChange={(e) => setFilters({ ...filters, query: e.target.value })}
              className="mt-2"
            />
          </label>
          <label htmlFor={`${id}-kind`} className="text-sm">
            活動の種類
            <NativeSelect
              id={`${id}-kind`}
              name="kind"
              value={filters.kind}
              onChange={(e) => setFilters({ ...filters, kind: e.target.value as ActivityHistoryFilters["kind"] })}
              className="mt-2"
            >
              <option value="all">すべて</option>
              {ACTIVITY_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label htmlFor={`${id}-consultations`} className="text-sm">
            運営への相談
            <NativeSelect
              id={`${id}-consultations`}
              name="consultations"
              value={filters.consultations}
              onChange={(e) =>
                setFilters({ ...filters, consultations: e.target.value as ActivityHistoryFilters["consultations"] })
              }
              className="mt-2"
            >
              <option value="all">すべて</option>
              <option value="only">相談を含む記録だけ</option>
            </NativeSelect>
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <Button type="submit">履歴を検索</Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const next = { page: 1, query: "", kind: "all", consultations: "all" } as const;
                setFilters(next);
                void load(next);
              }}
            >
              条件をクリア
            </Button>
          </div>
        </form>
      </search>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p role="status">
          {loading
            ? retrying
              ? "接続を再確認中…"
              : "履歴を確認中…"
            : data
              ? `${data.total.toLocaleString()}件 / 全${data.allTotal.toLocaleString()}件${data.total ? `・${((data.filters.page - 1) * 20 + 1).toLocaleString()}〜${Math.min(data.filters.page * 20, data.total).toLocaleString()}件を表示` : ""}`
              : "履歴を確認できません"}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void load(attempted.current)}
        >
          最新の履歴に更新
        </Button>
      </div>
      {error && (
        <div role="alert" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          {error}
          <Button type="button" variant="outline" className="mt-2" onClick={() => void load(attempted.current)}>
            履歴を再読み込み
          </Button>
        </div>
      )}
      {data && (
        <p className="break-words text-xs leading-relaxed text-muted-foreground">
          表示条件：{data.filters.query ? `メモ「${data.filters.query}」 / ` : ""}
          {data.filters.kind === "all" ? "すべての活動" : activityKindLabel(data.filters.kind)}
          {data.filters.consultations === "only" ? " / 運営への相談を含む記録" : ""}
        </p>
      )}
      {data && (
        <>
          <ol className="grid min-w-0 gap-3" aria-label="活動の記録">
            {data.items.map((item) => (
              <li key={item.id} className="min-w-0 space-y-2 rounded-lg border p-4 text-sm">
                <p className="flex flex-wrap gap-x-3 gap-y-1">
                  <strong>{activityKindLabel(item.kind)}</strong>
                  <time dateTime={item.occurredAt} className="text-muted-foreground text-xs">
                    {formatDateTime(new Date(item.occurredAt))}
                  </time>
                </p>
                {item.note && <p className="whitespace-pre-wrap break-words leading-relaxed">{item.note}</p>}
                {item.consultOps && (
                  <Link
                    href={`/${audience}/consultations?focus=${item.id}`}
                    className="inline-flex min-h-11 items-center text-primary underline"
                  >
                    相談の回答・状況を見る →
                  </Link>
                )}
                {item.nextActionMode === "clear" && (
                  <p className="text-xs text-muted-foreground">次回対応日を解除しました</p>
                )}
                {item.nextActionAt && (
                  <p className="text-xs text-muted-foreground">
                    次回対応日：{formatDateTime(new Date(item.nextActionAt))}
                  </p>
                )}
              </li>
            ))}
          </ol>
          {!data.total && (
            <p className="rounded border border-dashed p-5 text-sm">
              {data.allTotal
                ? "条件に合う記録がありません。条件を変えて検索してください。"
                : "活動の記録はまだありません。"}
            </p>
          )}
          <nav aria-label="活動履歴のページ" className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={loading || data.filters.page <= 1}
              onClick={() => void load({ ...data.filters, page: data.filters.page - 1 })}
            >
              前の20件
            </Button>
            <span className="text-sm">
              {data.filters.page} / {data.pageCount}ページ
            </span>
            <Button
              type="button"
              variant="outline"
              disabled={loading || data.filters.page >= data.pageCount}
              onClick={() => void load({ ...data.filters, page: data.filters.page + 1 })}
            >
              次の20件
            </Button>
          </nav>
        </>
      )}
    </section>
  );
}
