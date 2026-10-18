"use client";
import type { ArticleLegacyPage } from "@siteoffer/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { changeLegacyAction } from "@/app/(ops)/ops/content/[companyId]/migration/actions";
import { normalizeArticleLegacyPath } from "../../../../packages/core/src/content-legacy-path.ts";
export function ArticleLegacy({ companyId, data }: { companyId: string; data: ArticleLegacyPage }) {
  const [state, action, pending] = useActionState(changeLegacyAction, { nonce: "", ok: false, message: "" }),
    [operation, setOperation] = useState("enable"),
    [selected, setSelected] = useState<string[]>([]),
    [ready, setReady] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [paths, setPaths] = useState<Record<string, string>>({}),
    router = useRouter();
  const rowsKey = JSON.stringify(
    data.items.map((item) => [item.id, item.fingerprint, item.legacyRevision, item.path, item.conflict]),
  );
  useEffect(() => {
    void rowsKey;
    setReady(true);
    setSelected([]);
    setConfirmed(false);
  }, [rowsKey]);
  useEffect(() => {
    if (state.nonce) {
      setConfirmed(false);
      if (state.ok) setSelected([]);
      router.refresh();
    }
  }, [state.nonce, state.ok, router]);
  const valueFor = (item: ArticleLegacyPage["items"][number]) => paths[item.id] ?? item.legacyPath ?? item.path ?? "";
  const normalized = (item: ArticleLegacyPage["items"][number]) => normalizeArticleLegacyPath(valueFor(item));
  const eligible = (item: ArticleLegacyPage["items"][number]) =>
    operation === "disable"
      ? !!item.legacyPath
      : !!normalized(item) && !(item.conflict && normalized(item) === item.path);
  const chosen = data.items.filter((item) => selected.includes(item.id) && eligible(item));
  const duplicate = operation === "enable" && new Set(chosen.map(normalized)).size !== chosen.length;
  function choose(value: Parameters<typeof setSelected>[0]) {
    setSelected(value);
    setConfirmed(false);
  }
  return (
    <form action={action} className="space-y-4" aria-busy={pending}>
      <noscript>
        <p>設定操作にはJavaScriptが必要です。対応表はこのまま確認できます。</p>
      </noscript>
      <input type="hidden" name="companyId" value={companyId} />
      <input
        type="hidden"
        name="selected"
        value={JSON.stringify(
          chosen.map((item) => ({
            id: item.id,
            fingerprint: item.fingerprint,
            legacyRevision: item.legacyRevision,
            ...(operation === "enable" ? { path: normalized(item)! } : {}),
          })),
        )}
      />
      <fieldset disabled={!ready || pending} className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            操作
            <select
              name="operation"
              value={operation}
              onChange={(event) => {
                setOperation(event.target.value);
                choose([]);
              }}
              className="ml-2 rounded border p-2"
            >
              <option value="enable">旧URLを有効にする</option>
              <option value="disable">引き継ぎを解除する</option>
            </select>
          </label>
          <button
            type="button"
            className="rounded border px-3 py-2 text-sm"
            onClick={() => choose(data.items.filter(eligible).map((item) => item.id))}
          >
            このページの対象を選択
          </button>
          <button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => choose([])}>
            選択を解除
          </button>
        </div>
        <ul className="space-y-3">
          {data.items.map((item) => (
            <li key={item.id} className="rounded-xl border bg-white p-4 text-sm">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id={`legacy-select-${item.id}`}
                  aria-label={`${item.slug}を選択`}
                  checked={selected.includes(item.id)}
                  disabled={!eligible(item)}
                  onChange={(event) =>
                    choose((current) =>
                      event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                    )
                  }
                />
                <div className="min-w-0 flex-1">
                  <label htmlFor={`legacy-select-${item.id}`} className="break-all font-semibold">
                    {item.slug}
                  </label>
                  <span className="ml-3">
                    {item.legacyPath ? "引き継ぎ有効" : "未設定"} ·{" "}
                    {item.publishedRevision === null
                      ? "記事は未掲載"
                      : data.sitePublished
                        ? "掲載中"
                        : "サイトは未公開"}
                  </span>
                  <span className="mt-2 block break-all">元記事URL：{item.sourceUrl ?? "指定なし"}</span>
                  <label className="mt-3 block text-xs">
                    引き継ぐパス（ドメイン以降）
                    <input
                      type="text"
                      aria-label={`${item.slug}の引き継ぐパス`}
                      value={valueFor(item)}
                      maxLength={2048}
                      disabled={operation === "disable"}
                      onChange={(event) => {
                        setPaths((current) => ({ ...current, [item.id]: event.target.value }));
                        choose(selected);
                      }}
                      placeholder="/old-news/article.html"
                      className="mt-2 block w-full min-w-0 rounded border p-2 font-mono"
                    />
                  </label>
                  <code className="mt-2 block break-all">
                    適用するパス：{normalized(item) ?? "有効なパスを指定してください"}
                  </code>
                  <span className="mt-2 block break-all">転送先：{item.target}</span>
                  {item.conflict && normalized(item) === item.path && (
                    <span className="mt-2 block text-amber-900">
                      別の記事で使用中です。先にその記事の引き継ぎを解除してください。
                    </span>
                  )}
                  {!normalized(item) && (
                    <span className="mt-2 block text-amber-900">
                      {valueFor(item)
                        ? "公開画面と衝突するパス、認証情報・フラグメント・不正な文字などを含むURLは対象外です。"
                        : "引き継ぐ旧URLがある場合は、ドメイン以降のパスを入力してください。"}
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
        {!data.items.length && (
          <p className="rounded-xl border p-5">
            条件に合う記事はありません。検索条件を変えるか、記事を取り込んでください。
          </p>
        )}
        <p className="text-sm">選択中 {chosen.length}件</p>
        {duplicate && (
          <p role="alert" className="text-sm text-amber-900">
            同じ旧URLを複数の記事に選んでいます。1件に絞るか、別のパスを指定してください。
          </p>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="confirmed"
            required
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>旧URLがこの会社のものであり、転送先が正しいことと、選んだ有効化・解除の影響を確認しました。</span>
        </label>
        <button
          className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          type="submit"
          disabled={!ready || !chosen.length || !confirmed || duplicate}
        >
          {pending ? "設定を照合しています…" : "確認した設定を適用"}
        </button>
      </fieldset>
      {state.message && (
        <p role="status" className={`rounded-lg border p-4 text-sm ${state.ok ? "bg-emerald-50" : "bg-amber-50"}`}>
          {state.message}
        </p>
      )}
    </form>
  );
}
