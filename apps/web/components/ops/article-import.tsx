"use client";
import type { ArticleImportPreview } from "@siteoffer/core";
import { ARTICLE_IMPORT_MAX_BYTES, ARTICLE_IMPORT_TEMPLATE, type ArticleImportSource } from "@siteoffer/schemas";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { commitArticleImportAction, previewArticleImportAction } from "@/app/content-import-actions";
import { Button } from "@/components/ui/button";
import { fmtDateOnly } from "@/lib/ops/format";
export function ArticleImport({ companyId, companyName }: { companyId: string; companyName: string }) {
  const id = useId(),
    router = useRouter(),
    [busy, start] = useTransition();
  const [source, setSource] = useState<ArticleImportSource | null>(null),
    [preview, setPreview] = useState<ArticleImportPreview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null),
    [done, setDone] = useState(false),
    [stale, setStale] = useState(false),
    [wordpressCategory, setWordpressCategory] = useState<"news" | "blog">("blog");
  const receipt = useRef<string | null>(null),
    sending = useRef(false);
  async function inspect(input: ArticleImportSource) {
    setConfirmed(false);
    setDone(false);
    setStale(false);
    setMessage(null);
    receipt.current = null;
    const result = await previewArticleImportAction(input);
    if (result.ok) setPreview(result.value);
    else {
      setPreview(null);
      setMessage({ ok: false, text: result.message ?? "確認できませんでした" });
    }
  }
  async function read(file: File) {
    setSource(null);
    setPreview(null);
    setMessage(null);
    setDone(false);
    setConfirmed(false);
    receipt.current = null;
    try {
      if (file.size > ARTICLE_IMPORT_MAX_BYTES) throw Error("ファイルは2MB以内にしてください");
      const extension = file.name.split(".").pop()?.toLowerCase();
      if (extension !== "csv" && extension !== "json" && extension !== "xml")
        throw Error("CSV・JSON・WordPress XMLファイルを選んでください");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw Error("UTF-8で保存したファイルを選んでください。Shift-JISのCSVはUTF-8へ変換してください。");
      }
      const input = {
        companyId,
        fileName: file.name,
        format: extension === "xml" ? "wordpress" : extension,
        text,
        ...(extension === "xml" ? { wordpressCategory } : {}),
      } satisfies ArticleImportSource;
      setSource(input);
      await inspect(input);
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "ファイルを読み込めませんでした" });
    }
  }
  async function save() {
    if (!source || !preview || sending.current) return;
    sending.current = true;
    receipt.current ??= crypto.randomUUID();
    try {
      const r = await commitArticleImportAction({
        ...source,
        fingerprint: preview.fingerprint,
        requestId: receipt.current,
        confirmed,
      });
      if (r.ok) {
        setDone(true);
        setConfirmed(false);
        setMessage({
          ok: true,
          text: `下書き${r.value.importedCount}件を保存しました。既存の記事${r.value.skippedCount}件は変更していません。`,
        });
        router.refresh();
      } else {
        setMessage({ ok: false, text: r.message ?? "保存できませんでした" });
        if (r.error === "conflict" || r.error === "request_conflict") setStale(true);
      }
    } catch {
      setMessage({ ok: false, text: "通信結果を確認できません。同じ内容で再試行できます。" });
    } finally {
      sending.current = false;
    }
  }
  function template() {
    const url = URL.createObjectURL(new Blob(["\uFEFF", ARTICLE_IMPORT_TEMPLATE], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "article-import-template.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section aria-label="記事の一括取り込み" className="mb-6 space-y-5 rounded-xl border bg-card p-5">
      <div className="space-y-2 text-sm">
        <h2 className="font-semibold text-lg">1. ファイルを選ぶ</h2>
        <p>
          対象企業：<strong>{companyName}</strong>
        </p>
        <p>UTF-8のCSV・JSON・WordPressのエクスポートXMLを使用できます。1回100記事・2MBまで。</p>
        <p>本文はテキストとして取り込みます。画像・添付ファイル・装飾・旧URLからの転送は別途確認してください。</p>
        <Button variant="outline" size="sm" type="button" onClick={template}>
          CSVテンプレートをダウンロード
        </Button>
        <details>
          <summary className="cursor-pointer">ファイル形式と重複の扱い</summary>
          <div className="mt-2 space-y-2">
            <p>
              必須項目：slug（URL名）、title（見出し）、body（本文）、category（news または
              blog）。任意項目：sourceUrl（元記事URL）、originalPublishedAt（元の掲載日）。掲載日は2026-01-15のように入力します。
            </p>
            <p>
              同じURL名の記事は、内容が異なっていてもスキップします。既存の記事・掲載版は変更しません。ファイル内でURL名が重複する場合や不正な行がある場合は、修正してから再確認してください。
            </p>
            <p>JSONの書き出しを戻す場合は現在の下書き版だけを読みます。過去の版・掲載設定は移行しません。</p>
            <p>
              WordPressでは「ツール → エクスポート → 投稿」から、公開済みの投稿を期間で分けて書き出せます。WXR
              1.0〜1.2に対応します。公開投稿だけを下書きにし、元URLとUTC掲載日時を保持します。固定ページ・カスタム投稿・添付・非公開・予約・パスワード付き投稿は取り込みません。
            </p>
            <p>
              WordPressの本文はテキストへ変換します。画像や埋め込みは確認用の印を残します。装飾・コメント・作者・カスタム項目を移行せず、外部ファイルを取得しません。日本語などのURL名はwp-投稿IDへ変換し、旧URLの引き継ぎで確認できます。
            </p>
          </div>
        </details>
        <label className="block font-medium">
          WordPress投稿の取り込み先
          <select
            value={wordpressCategory}
            disabled={busy || done}
            className="ml-2 rounded border p-2"
            onChange={(event) => {
              const category = event.target.value === "news" ? "news" : "blog";
              setWordpressCategory(category);
              if (source?.format === "wordpress") {
                const next: ArticleImportSource = { ...source, wordpressCategory: category };
                setSource(next);
                start(() => inspect(next));
              }
            }}
          >
            <option value="blog">ブログ</option>
            <option value="news">お知らせ</option>
          </select>
        </label>
        <label htmlFor={id} className="block font-medium">
          記事ファイル
        </label>
        <input
          id={id}
          type="file"
          accept=".csv,.json,.xml,text/csv,application/json,text/xml,application/xml"
          disabled={busy}
          className="block w-full min-w-0 text-sm"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) start(() => read(file));
          }}
        />
      </div>
      {busy && (
        <p role="status" className="text-sm">
          処理しています…
        </p>
      )}
      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={`rounded-lg p-3 text-sm ${message.ok ? "bg-green-50 text-green-900" : "bg-amber-50 text-amber-900"}`}
        >
          {message.text}
        </p>
      )}
      {source && !done && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => start(() => inspect(source))}>
          同じファイルを最新の記事と再照合
        </Button>
      )}
      {preview && !done && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">2. 取り込む内容を確認</h2>
          <p className="text-sm">
            新しい下書き {preview.newCount}件 / 既存のためスキップ {preview.skippedCount}件
          </p>
          {preview.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
              <h3 className="font-semibold">取り込み時の確認事項</h3>
              <ul className="mt-2 list-disc space-y-2 pl-5 leading-6">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {!!preview.errors.length && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
              <p className="font-semibold">修正が必要です。この状態では保存しません。</p>
              <ul className="mt-2 list-disc pl-5">
                {preview.errors.map((e) => (
                  <li key={`${e.row}-${e.message}`}>
                    {e.row ? `記事${e.row}：` : ""}
                    {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ol className="space-y-3">
            {preview.rows.map((r) => (
              <li key={r.article.slug} className="min-w-0 rounded-xl border p-4 text-sm space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="min-w-0 font-semibold break-words">{r.article.title}</h3>
                  <span className={r.status === "new" ? "text-blue-700" : "text-amber-800"}>
                    {r.status === "new"
                      ? "下書きを新規作成"
                      : r.status === "identical"
                        ? "同じ内容のためスキップ"
                        : "同じURL名・内容が異なるためスキップ"}
                  </span>
                </div>
                <p className="break-all">
                  /{r.article.slug} · {r.article.category === "news" ? "お知らせ" : "ブログ"}
                </p>
                <p>
                  元の掲載日：{r.article.originalPublishedAt ? fmtDateOnly(r.article.originalPublishedAt) : "記録なし"}
                </p>
                {r.article.sourceUrl && <p className="break-all">元記事：{r.article.sourceUrl}</p>}
                <details>
                  <summary className="cursor-pointer">本文を確認（{r.article.body.length}文字）</summary>
                  <p className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words">{r.article.body}</p>
                </details>
                {r.existingId && (
                  <Link
                    target="_blank"
                    href={`/ops/content?company=${companyId}&entry=${r.existingId}`}
                    className="text-primary underline"
                  >
                    既存の記事を別タブで確認
                  </Link>
                )}
              </li>
            ))}
          </ol>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              start(save);
            }}
            className="space-y-3 border-t pt-4"
          >
            <h2 className="text-lg font-semibold">3. 下書きに取り込む</h2>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                required
                checked={confirmed}
                disabled={busy || stale || !!preview.errors.length || !preview.newCount}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                対象企業・本文・利用権利を確認しました。既存の記事は上書きせず、新しい記事だけを未掲載の下書きとして保存します。
              </span>
            </label>
            <Button
              type="submit"
              disabled={busy || stale || !confirmed || !!preview.errors.length || !preview.newCount}
            >
              {preview.newCount}件を下書きに取り込む
            </Button>
          </form>
        </div>
      )}
      {done && (
        <Link href={`/ops/content?company=${companyId}`} className="inline-block text-sm text-primary underline">
          取り込んだ記事を確認・編集する
        </Link>
      )}
    </section>
  );
}
