"use client";
import type { ArticleImage, ArticleImageChoice } from "@siteoffer/core";
import { useEffect, useRef, useState } from "react";
export function ArticleImages({
  companyId,
  audience,
  initialChoices,
  images,
  onChange,
}: {
  companyId: string;
  audience: "ops" | "customer";
  initialChoices: ArticleImageChoice[];
  images: ArticleImage[];
  onChange: (images: ArticleImage[]) => void;
}) {
  const [choices, setChoices] = useState(initialChoices),
    [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function refresh() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const timer = setTimeout(() => controller.abort(), 20000);
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/article-images/${companyId}/choices`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw Error(data.message || "写真の一覧を更新できませんでした");
      setChoices(data.result);
    } catch (e) {
      setError(
        e instanceof Error && e.name !== "AbortError"
          ? e.message
          : "写真の確認に時間がかかっています。入力は残っています。再試行してください。",
      );
    } finally {
      clearTimeout(timer);
      request.current = null;
      setLoading(false);
    }
  }
  function update(index: number, key: "alt" | "caption", value: string) {
    onChange(images.map((image, i) => (i === index ? { ...image, [key]: value } : image)));
  }
  function move(index: number, delta: number) {
    const next = [...images],
      target = index + delta;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }
  return (
    <section aria-label="記事の写真" className="article-photos space-y-4">
      <div>
        <h3 className="font-semibold">
          記事の写真 <span className="text-sm font-normal">{images.length} / 8枚</span>
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          写真は本文の前に並びます。最初の写真を記事一覧にも表示します。掲載には代替テキストが必要です。顧客の提出写真は運営の受付後、運営が登録した写真は納品時に顧客が画像の権利に同意した後に掲載できます。
        </p>
      </div>
      {images.map((image, index) => {
        const item = choices.find((c) => c.id === image.assetId);
        return (
          <fieldset key={image.assetId} className="rounded-lg border bg-slate-50 p-4">
            <legend className="px-1 text-sm font-semibold">
              写真 {index + 1}：{item?.label ?? "一覧にない写真"}
            </legend>
            <div className="grid min-w-0 gap-4 sm:grid-cols-[140px_minmax(0,1fr)]">
              {/* biome-ignore lint/performance/noImgElement: Each request must recheck permission; image optimization could retain withdrawn photos. */}
              <img
                className="article-photo-thumb"
                src={`/article-images/${companyId}/${image.assetId}`}
                alt={image.alt}
                loading="lazy"
              />
              <div className="min-w-0 space-y-3">
                <p className={`text-xs ${item?.approved ? "text-green-700" : "text-amber-800"}`}>
                  {item?.status ?? "素材の状態を更新して確認してください"}
                </p>
                <label className="block text-sm">
                  写真 {index + 1}の代替テキスト
                  <input
                    aria-label={`写真 ${index + 1}の代替テキスト`}
                    value={image.alt}
                    maxLength={200}
                    onChange={(e) => update(index, "alt", e.target.value)}
                    className="mt-1 block w-full rounded border p-2"
                    placeholder="写真の内容が分かる短い説明"
                  />
                </label>
                <label className="block text-sm">
                  写真 {index + 1}の説明・クレジット（任意）
                  <input
                    aria-label={`写真 ${index + 1}の説明・クレジット`}
                    value={image.caption}
                    maxLength={400}
                    onChange={(e) => update(index, "caption", e.target.value)}
                    className="mt-1 block w-full rounded border p-2"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="design-button secondary"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={`写真 ${index + 1}を前へ`}
                  >
                    前へ
                  </button>
                  <button
                    type="button"
                    className="design-button secondary"
                    disabled={index === images.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={`写真 ${index + 1}を後へ`}
                  >
                    後へ
                  </button>
                  <button
                    type="button"
                    className="design-button secondary"
                    onClick={() => onChange(images.filter((_, i) => i !== index))}
                    aria-label={`写真 ${index + 1}を記事から外す`}
                  >
                    記事から外す
                  </button>
                </div>
              </div>
            </div>
          </fieldset>
        );
      })}
      {images.length < 8 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-sm">
            追加する写真
            <select
              aria-label="追加する写真"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="mt-2 block w-full"
            >
              <option value="">素材から選んでください</option>
              {choices
                .filter((c) => !images.some((i) => i.assetId === c.id))
                .map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.label}
                    {c.approved ? "" : "（許諾確認が必要）"}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            className="design-button secondary"
            disabled={!choices.some((c) => c.id === selected) || images.some((i) => i.assetId === selected)}
            onClick={() => {
              const item = choices.find((c) => c.id === selected);
              if (item) {
                onChange([...images, { assetId: item.id, alt: item.label.slice(0, 200), caption: "" }]);
                setSelected("");
              }
            }}
          >
            写真を追加
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <a
          className="text-blue-700 underline"
          href={audience === "customer" ? `/customer/materials?company=${companyId}` : `/ops/companies/${companyId}`}
          target="_blank"
          rel="noreferrer"
        >
          {audience === "customer" ? "写真を提出" : "素材台帳を開く"}（別タブ）
        </a>
        <button type="button" className="design-button secondary" disabled={loading} onClick={() => void refresh()}>
          {loading ? "写真を確認中…" : "写真の一覧を更新"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
