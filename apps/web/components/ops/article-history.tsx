"use client";
import type { ArticleHistoryPage, ArticleSnapshot, ArticleWorkspace } from "@siteoffer/core";
import { useEffect, useRef, useState } from "react";

const snapshot = (w: ArticleWorkspace): ArticleSnapshot => ({
  revision: Number(w.current.baseRevision),
  title: w.current.title,
  body: w.current.body,
  category: w.current.category,
  images: w.current.images ?? [],
});
function validSnapshot(value: unknown): value is ArticleSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as ArticleSnapshot;
  return (
    Number.isSafeInteger(v.revision) &&
    v.revision > 0 &&
    typeof v.title === "string" &&
    typeof v.body === "string" &&
    typeof v.category === "string" &&
    Array.isArray(v.images) &&
    v.images.length <= 8 &&
    v.images.every((i) => typeof i.assetId === "string" && typeof i.alt === "string" && typeof i.caption === "string")
  );
}
function validHistory(value: unknown): value is ArticleHistoryPage {
  if (!value || typeof value !== "object") return false;
  const v = value as ArticleHistoryPage;
  return (
    v.pageSize === 20 &&
    Number.isSafeInteger(v.total) &&
    v.total >= 0 &&
    Number.isSafeInteger(v.pageCount) &&
    v.pageCount >= 1 &&
    !!v.filters &&
    typeof v.filters.query === "string" &&
    Number.isSafeInteger(v.filters.page) &&
    v.filters.page > 0 &&
    v.filters.page <= v.pageCount &&
    Array.isArray(v.items) &&
    v.items.length <= 20 &&
    v.items.every(
      (i) =>
        Number.isSafeInteger(i.revision) &&
        typeof i.title === "string" &&
        typeof i.category === "string" &&
        typeof i.createdAt === "string",
    )
  );
}
async function read(base: string, params: URLSearchParams, controller: AbortController) {
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${base}?${params}`, {
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) throw new Error("read failed");
    return (await res.json()) as { kind?: string; result?: unknown };
  } finally {
    clearTimeout(timer);
  }
}

export function useArticleHistory(workspace: ArticleWorkspace, onSelect: () => void) {
  const [data, setData] = useState(workspace.history),
    [query, setQuery] = useState(workspace.history.filters.query);
  const [target, setTarget] = useState(
    workspace.current.baseRevision === "0" ? "none" : workspace.current.baseRevision,
  );
  const [selected, setSelected] = useState<ArticleSnapshot | null>(target === "none" ? null : snapshot(workspace));
  const [choice, setChoice] = useState(selected ? { revision: selected.revision, title: selected.title } : null);
  const [loading, setLoading] = useState(false),
    [listing, setListing] = useState(false);
  const [error, setError] = useState(""),
    [listError, setListError] = useState("");
  const version = useRef(0),
    pageVersion = useRef(0),
    request = useRef<AbortController | null>(null),
    pageRequest = useRef<AbortController | null>(null);
  const attempted = useRef(data.filters);
  const base = `/article-history/${workspace.scope.companyId}/${workspace.scope.entryId}`;
  useEffect(
    () => () => {
      version.current++;
      pageVersion.current++;
      request.current?.abort();
      pageRequest.current?.abort();
    },
    [],
  );
  async function select(value: string, updated = workspace) {
    const ticket = ++version.current;
    request.current?.abort();
    onSelect();
    setTarget(value);
    setError("");
    if (value === "none") {
      setChoice(null);
      setSelected(null);
      setLoading(false);
      return;
    }
    const revision = Number(value),
      current = snapshot(updated);
    const known = [current, updated.published, selected].find((s) => s?.revision === revision);
    setChoice({
      revision,
      title: known?.title ?? data.items.find((i) => i.revision === revision)?.title ?? `第${revision}版`,
    });
    if (known) {
      setSelected(known);
      setLoading(false);
      return;
    }
    setSelected(null);
    setLoading(true);
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await read(base, new URLSearchParams({ revision: String(revision) }), controller);
      if (ticket !== version.current) return;
      if (result.kind !== "revision" || !validSnapshot(result.result) || result.result.revision !== revision)
        throw new Error("invalid revision");
      setSelected(result.result);
      setChoice({ revision, title: result.result.title });
    } catch {
      if (ticket === version.current)
        setError("選んだ版を取得できませんでした。入力は残っています。再読み込みしてください。");
    } finally {
      if (ticket === version.current) setLoading(false);
    }
  }
  async function load(page: number, text: string) {
    const ticket = ++pageVersion.current;
    pageRequest.current?.abort();
    setListing(true);
    setListError("");
    attempted.current = { page, query: text };
    const controller = new AbortController();
    pageRequest.current = controller;
    try {
      const result = await read(base, new URLSearchParams({ page: String(page), q: text }), controller);
      if (ticket !== pageVersion.current) return;
      if (result.kind !== "history" || !validHistory(result.result)) throw new Error("invalid history");
      setData(result.result);
      const normalized = result.result.filters.query;
      setQuery((current) => (current === text ? normalized : current));
    } catch {
      if (ticket === pageVersion.current)
        setListError("履歴を取得できませんでした。前回の一覧を表示しています。入力は残っています。");
    } finally {
      if (ticket === pageVersion.current) setListing(false);
    }
  }
  function resetIndex(next: ArticleHistoryPage) {
    ++pageVersion.current;
    pageRequest.current?.abort();
    setData(next);
    setQuery(next.filters.query);
    setListing(false);
    setListError("");
    attempted.current = next.filters;
  }
  const choices = [snapshot(workspace), workspace.published, choice, ...data.items].filter(
    (v, i, all) => v && v.revision > 0 && all.findIndex((other) => other?.revision === v.revision) === i,
  );
  return {
    data,
    query,
    setQuery,
    target,
    selected,
    loading,
    listing,
    error,
    listError,
    choices,
    select,
    load,
    resetIndex,
    retry: () => load(attempted.current.page, attempted.current.query),
  };
}

export function ArticleHistoryControls({ history }: { history: ReturnType<typeof useArticleHistory> }) {
  const { data } = history;
  return (
    <div className="my-4 space-y-3 rounded-lg border bg-slate-50 p-4" aria-busy={history.listing}>
      <search aria-label="版の履歴を検索" className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-sm">
          履歴の見出し・本文
          <input
            type="search"
            aria-label="履歴の見出し・本文"
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2"
            value={history.query}
            onChange={(e) => history.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void history.load(1, history.query);
              }
            }}
            maxLength={120}
            placeholder="過去の文面から探す"
          />
        </label>
        <button type="button" className="design-button secondary" onClick={() => void history.load(1, history.query)}>
          履歴を検索
        </button>
      </search>
      <p className="text-xs text-slate-500" role="status">
        {history.listing ? "履歴を取得中…" : `全${data.total}版 / ${data.filters.page} / ${data.pageCount}ページ`}
      </p>
      {!data.items.length && !history.listing && (
        <p className="text-sm">条件に合う版はありません。現在の下書き・掲載版・選択中の版は引き続き確認できます。</p>
      )}
      {history.listError && (
        <div role="alert" className="text-sm text-amber-800">
          <p>{history.listError}</p>
          <button type="button" className="underline" onClick={() => void history.retry()}>
            履歴の再読み込み
          </button>
        </div>
      )}
      <nav aria-label="記事の版のページ" className="flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          className="design-button secondary"
          disabled={data.filters.page <= 1 || history.listing}
          onClick={() => void history.load(data.filters.page - 1, data.filters.query)}
        >
          前の20版
        </button>
        <button
          type="button"
          className="design-button secondary"
          disabled={data.filters.page >= data.pageCount || history.listing}
          onClick={() => void history.load(data.filters.page + 1, data.filters.query)}
        >
          次の20版
        </button>
      </nav>
    </div>
  );
}
