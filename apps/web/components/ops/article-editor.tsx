"use client";
import type { ArticleImageChoice, ArticleOperation, ArticleValues, ArticleWorkspace } from "@siteoffer/core";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { refreshArticleAction, saveArticleCopyAction, submitArticleAction } from "@/app/(ops)/ops/content/actions";
import { usePersonalDraft } from "@/components/use-personal-draft";
import { type ContentIndexQuery, contentIndexHref } from "@/lib/content-index-query";
import { ArticleImages } from "./article-images";
import { preservesArticleFilter } from "./content-filter-navigation";
import "./article-editor.css";

const same = (a: ArticleValues, b: ArticleValues) =>
  a.slug === b.slug &&
  a.title === b.title &&
  a.body === b.body &&
  a.category === b.category &&
  JSON.stringify(a.images ?? []) === JSON.stringify(b.images ?? []);
function ArticlePreview({
  title,
  body,
  category,
  images = [],
  imageBase,
}: Pick<ArticleValues, "title" | "body" | "category" | "images"> & { imageBase: string }) {
  return (
    <article className="min-w-0 rounded-lg border bg-slate-50 p-4 break-words">
      <p className="text-xs text-slate-500">{category === "blog" ? "ブログ" : "お知らせ"}</p>
      <h4 className="my-3 font-bold">{title || "見出しが入ります"}</h4>
      {images.map((image) => (
        <figure key={image.assetId} className="my-3">
          {/* biome-ignore lint/performance/noImgElement: Each request must recheck permission; image optimization could retain withdrawn photos. */}
          <img className="article-preview-photo" src={`${imageBase}/${image.assetId}`} alt={image.alt} loading="lazy" />
          {image.caption && <figcaption className="mt-1 text-xs text-slate-500">{image.caption}</figcaption>}
        </figure>
      ))}
      <p className="whitespace-pre-wrap text-sm leading-7">{body || "本文が入ります"}</p>
    </article>
  );
}
export function ArticleEditor({
  initial,
  publicSite,
  audience = "ops",
  imageChoices = [],
  listContext,
}: {
  initial: ArticleWorkspace;
  imageChoices?: ArticleImageChoice[];
  listContext?: ContentIndexQuery;
  publicSite: boolean;
  audience?: "ops" | "customer";
}) {
  const router = useRouter();
  const inputId = useId();
  const imageBase = `/article-images/${initial.scope.companyId}`;
  const [workspace, setWorkspace] = useState(initial);
  const draft = usePersonalDraft(
    initial.copy,
    initial.current,
    (revision, values) => saveArticleCopyAction(initial.scope, revision, values),
    (target) =>
      preservesArticleFilter(target, initial.scope, audience === "customer" ? "/customer/content" : "/ops/content"),
  );
  const [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false);
  const [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [target, setTarget] = useState(initial.current.baseRevision === "0" ? "none" : initial.current.baseRevision);
  const [confirmed, setConfirmed] = useState(false),
    [preview, setPreview] = useState(false);
  const pending = useRef<ArticleOperation | null>(null),
    running = useRef(false);
  const locked = busy || unknown || !draft.ready;
  const stale = draft.values.baseRevision !== workspace.current.baseRevision;
  const changed = !same(draft.values, workspace.current);
  const selected = workspace.history.find((r) => String(r.revision) === target);
  const published = workspace.history.find((r) => r.revision === workspace.publishedRevision);
  function change(key: keyof ArticleValues, value: string) {
    setMessage("");
    setError("");
    setConfirmed(false);
    const next = { ...draft.latest.current, [key]: value };
    if (!initial.scope.entryId && key === "title" && value.trim() && !next.slug)
      next.slug = `news-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    draft.change(next);
  }
  function observe(next: ArticleWorkspace) {
    setWorkspace(next);
    setConfirmed(false);
    if (next.copy.revision !== draft.revision.current) draft.showConflict(next.copy);
  }
  async function perform(kind: "save" | "publish") {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    draft.cancelPendingSave();
    try {
      if (!pending.current) {
        if (!(await draft.flush())) return;
        pending.current =
          kind === "save"
            ? { kind, requestId: crypto.randomUUID(), copyRevision: draft.revision.current }
            : {
                kind,
                requestId: crypto.randomUUID(),
                expectedRevision: Number(workspace.current.baseRevision),
                expectedPublicationRevision: workspace.publicationRevision,
                revision: target === "none" ? null : Number(target),
                confirmed,
              };
      }
      const operation = pending.current;
      const result = await submitArticleAction(initial.scope, operation);
      pending.current = null;
      setUnknown(false);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      if (result.status === "conflict") {
        observe(result.workspace);
        setError(result.message);
        return;
      }
      setWorkspace(result.workspace);
      setConfirmed(false);
      if (operation.kind === "save") {
        if (!initial.scope.entryId) {
          router.replace(
            contentIndexHref(audience === "customer" ? "/customer/content" : "/ops/content", {
              ...(listContext ?? {
                companyId: initial.scope.companyId,
                filters: { page: 1, query: "", category: "all", publication: "all" },
                companies: { page: 1, query: "" },
              }),
              view: "edit",
              entryId: result.workspace.scope.entryId,
            }),
          );
          return;
        }
        draft.applyStored(result.workspace.copy, result.workspace.current);
        setTarget(String(result.savedRevision));
        setMessage(`第${result.savedRevision}版を下書きとして保存しました。掲載内容は変わりません。`);
      } else {
        setMessage(
          result.replayed
            ? "受付済みの掲載操作を確認しました。現在の掲載状態を表示しています。"
            : "掲載設定を反映しました。",
        );
      }
    } catch {
      setUnknown(true);
      setError("通信が途切れ、操作結果を確認できません。同じ受付番号で結果を確認してください。入力は保持しています。");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    draft.cancelPendingSave();
    try {
      if (!(await draft.flush())) return;
      const result = await refreshArticleAction(initial.scope);
      if (result.status === "error") setError(result.message);
      else {
        observe(result.workspace);
        setMessage("最新の記事と掲載設定を確認しました。入力はそのままです。");
      }
    } catch {
      setError("最新の記事を確認できませんでした。入力は残っています");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function discard() {
    if (running.current || !window.confirm("自分の作業コピーを破棄して、最新の共有下書きを読み込みますか？")) return;
    running.current = true;
    setBusy(true);
    setError("");
    draft.cancelPendingSave();
    try {
      const result = await refreshArticleAction(initial.scope);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      await draft.discard(result.workspace.current);
      setWorkspace(result.workspace);
      setConfirmed(false);
    } catch {
      setError("作業コピーを破棄できませんでした。入力は残っています");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="article-editor min-w-0 space-y-6">
      <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm leading-6">
        <p className="font-semibold">① 自分専用の作業コピー → ② 下書きとして共有 → ③ 確認して掲載</p>
        <p>
          入力は自分専用に自動保存されます。「下書きを保存」で会社の記事として記録します。掲載操作まではサイトに反映されません。
        </p>
        <p role="status" className="mt-2 text-xs">
          作業コピー：{draft.status}
        </p>
      </div>
      {(error || draft.error) && (
        <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm">
          {error || draft.error}
          {unknown ? (
            <button
              type="button"
              className="design-button secondary mt-3"
              disabled={busy}
              onClick={() => void perform(pending.current?.kind ?? "save")}
            >
              同じ操作の結果を確認
            </button>
          ) : (
            draft.error && (
              <button
                type="button"
                className="design-button secondary mt-3"
                disabled={busy}
                onClick={() => void draft.flush()}
              >
                自動保存を再試行
              </button>
            )
          )}
          <p className="mt-2">
            ログイン期限が切れた場合は、
            <a className="underline" href="/login" target="_blank" rel="noreferrer">
              別のタブでログイン
            </a>
            して再試行してください。
          </p>
        </div>
      )}
      {message && (
        <p role="status" className="rounded border border-green-200 bg-green-50 p-3 text-sm">
          {message}
        </p>
      )}
      {draft.conflict && (
        <section aria-label="作業コピーの競合" className="rounded border border-amber-300 bg-amber-50 p-4 space-y-3">
          <h3>別の画面で作業コピーが変更されています</h3>
          <p className="text-sm">下の保存内容と、入力欄に残っている内容を比較して選んでください。</p>
          {draft.conflict.values ? (
            <ArticlePreview imageBase={imageBase} {...draft.conflict.values} />
          ) : (
            <p>別の画面では作業コピーを破棄、または共有下書きとして保存済みです。</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="design-button secondary"
              disabled={locked}
              onClick={() => draft.applyStored(draft.conflict!, workspace.current)}
            >
              別画面の保存内容を使う
            </button>
            <button
              type="button"
              className="design-button secondary"
              disabled={locked}
              onClick={() => void draft.keepMine()}
            >
              この画面の入力を残す
            </button>
          </div>
        </section>
      )}
      {stale && (
        <section aria-label="記事の更新比較" className="rounded border border-amber-300 bg-amber-50 p-4 space-y-3">
          <h3>共有下書きが更新されています</h3>
          <p className="text-sm">
            最新は第{workspace.current.baseRevision}版です。自分の入力を残したまま、下の最新内容を確認してください。
          </p>
          <ArticlePreview imageBase={imageBase} {...workspace.current} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="design-button secondary"
              disabled={locked || !!draft.conflict}
              onClick={() => {
                draft.change({ ...draft.latest.current, baseRevision: workspace.current.baseRevision });
                setError("");
              }}
            >
              比較済み・この入力で新しい版を作る
            </button>
            <button
              type="button"
              className="design-button secondary"
              disabled={locked || !!draft.conflict}
              onClick={() => void discard()}
            >
              最新の共有下書きに戻す
            </button>
          </div>
        </section>
      )}
      <form
        ref={draft.formRef}
        onSubmit={(e) => {
          e.preventDefault();
          void perform("save");
        }}
      >
        <fieldset disabled={locked} className="min-w-0">
          <div className="my-4">
            <label htmlFor={`${inputId}-category`}>記事の種類</label>
            <select
              id={`${inputId}-category`}
              className="mt-2 block"
              aria-label="記事の種類"
              name="category"
              value={draft.values.category}
              onChange={(e) => change("category", e.target.value)}
            >
              <option value="news">お知らせ</option>
              <option value="blog">ブログ</option>
            </select>
          </div>
          <div className="my-4">
            <label htmlFor={`${inputId}-title`}>見出し</label>
            <input
              id={`${inputId}-title`}
              className="mt-2 block w-full rounded border p-3"
              name="title"
              required
              maxLength={160}
              value={draft.values.title}
              onChange={(e) => change("title", e.target.value)}
            />
          </div>
          <div className="my-4">
            <label htmlFor={`${inputId}-slug`}>
              {initial.scope.entryId ? "URL名（作成後は固定）" : "URL名（自動入力・変更できます）"}
            </label>
            <input
              id={`${inputId}-slug`}
              className="mt-2 block w-full rounded border p-3"
              name="slug"
              required
              maxLength={80}
              pattern="[a-z0-9][a-z0-9-]{0,79}"
              placeholder="summer-notice"
              readOnly={!!initial.scope.entryId}
              value={draft.values.slug}
              onChange={(e) => change("slug", e.target.value)}
            />
          </div>
          <div className="my-4">
            <label htmlFor={`${inputId}-body`}>本文</label>
            <textarea
              id={`${inputId}-body`}
              className="mt-2 block w-full rounded border p-3"
              name="body"
              required
              maxLength={30000}
              rows={12}
              value={draft.values.body}
              onChange={(e) => change("body", e.target.value)}
            />
          </div>
          <p className="design-muted">
            {draft.values.body.length.toLocaleString()} /
            30,000文字。本文はテキストとして表示します。HTMLは実行しません。
          </p>
          <ArticleImages
            companyId={initial.scope.companyId}
            audience={audience}
            initialChoices={imageChoices}
            images={draft.values.images ?? []}
            onChange={(images) => {
              setConfirmed(false);
              setError("");
              setMessage("");
              draft.change({ ...draft.latest.current, images });
            }}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="design-button" disabled={stale || !!draft.conflict || !changed} type="submit">
              下書きを保存
            </button>
            <button type="button" className="design-button secondary" onClick={() => setPreview(!preview)}>
              {preview ? "入力プレビューを閉じる" : "入力内容をプレビュー"}
            </button>
            <button
              type="button"
              className="design-button secondary"
              disabled={!!draft.conflict}
              onClick={() => void refresh()}
            >
              最新の記事を確認
            </button>
          </div>
          {(draft.hasDraft || changed) && (
            <button
              type="button"
              className="mt-4 text-xs underline"
              disabled={!!draft.conflict}
              onClick={() => void discard()}
            >
              自分の作業コピーを破棄
            </button>
          )}
        </fieldset>
      </form>
      {preview && (
        <section aria-label="入力内容のプレビュー">
          <h3>入力中の内容（まだ掲載されません）</h3>
          <ArticlePreview imageBase={imageBase} {...draft.values} />
        </section>
      )}
      {!!workspace.scope.entryId && (
        <section className="space-y-4 border-t pt-6" aria-label="掲載設定">
          <h3>掲載する内容を確認</h3>
          <p className="text-sm">
            現在：{workspace.publishedRevision ? `第${workspace.publishedRevision}版を掲載` : "未掲載"} ／
            共有下書き：第{workspace.current.baseRevision}版
          </p>
          <p className="design-muted">
            {publicSite
              ? "変更は公開サイトに反映されます。"
              : "サイトは未公開です。掲載版を選んでも、サイト公開の確認が終わるまで一般公開されません。"}
          </p>
          {(changed || stale) && (
            <p className="text-sm text-amber-800">
              入力中の変更があります。先に下書きとして保存するか、作業コピーを破棄してください。
            </p>
          )}
          <fieldset disabled={locked || changed || stale || !!draft.conflict}>
            <label>
              掲載版
              <select
                className="mt-2 block w-full"
                aria-label="掲載版"
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="none">掲載を停止する</option>
                {workspace.history.map((r) => (
                  <option key={r.revision} value={r.revision}>
                    第{r.revision}版：{r.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
              <div className="min-w-0">
                <h4 className="mb-2 text-sm font-semibold">現在の掲載内容</h4>
                {published ? (
                  <ArticlePreview imageBase={imageBase} {...published} />
                ) : (
                  <p className="p-4 text-sm">未掲載です</p>
                )}
              </div>
              <div className="min-w-0">
                <h4 className="mb-2 text-sm font-semibold">反映する内容</h4>
                {selected ? (
                  <ArticlePreview imageBase={imageBase} {...selected} />
                ) : (
                  <p className="rounded border p-4 text-sm">この記事を掲載から外します。保存済みの版は残ります。</p>
                )}
              </div>
            </div>
            <label className="design-check mt-4">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {target === "none" ? "掲載を停止することを確認しました" : "内容と利用権利を確認しました"}
            </label>
            <button
              className="design-button"
              type="button"
              disabled={
                !confirmed ||
                (target === "none"
                  ? workspace.publishedRevision === null
                  : Number(target) === workspace.publishedRevision)
              }
              onClick={() => void perform("publish")}
            >
              {target === "none" ? "掲載を停止" : "確認した版を掲載"}
            </button>
          </fieldset>
        </section>
      )}
    </div>
  );
}
