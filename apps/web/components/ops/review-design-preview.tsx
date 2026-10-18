"use client";

import { ExternalLink, ImageIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { ReviewDesign } from "@/lib/ops/review-design";

export function ReviewDesignPreview({ design }: { design: ReviewDesign | null }) {
  const [enlarged, setEnlarged] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <div className="site-column review-design-column">
      <div className="site-label">
        <h3>制作元の承認画像</h3>
        {design && <span>デザイン 第{design.version}版</span>}
      </div>
      {design ? (
        <>
          <fieldset className="review-image-tools" aria-label="承認画像の表示倍率">
            <button type="button" aria-pressed={!enlarged} onClick={() => setEnlarged(false)}>
              全体を表示
            </button>
            <button type="button" aria-pressed={enlarged} onClick={() => setEnlarged(true)}>
              実寸で確認
            </button>
            <a href={design.imageUrl} target="_blank" rel="noreferrer" aria-label="制作元の承認画像を別タブで開く">
              <ExternalLink size={14} />
            </a>
          </fieldset>
          <section
            className="review-image-viewport"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the full-size image.
            tabIndex={0}
            aria-label={enlarged ? "承認画像・実寸。スクロールして確認できます" : "承認画像・全体"}
          >
            {failed ? (
              <div className="preview-unavailable" role="status">
                <ImageIcon size={28} />
                <strong>承認画像を読み込めませんでした</strong>
                <p>制作元の版と画像の保存状態を確認してください。</p>
                <button
                  type="button"
                  onClick={() => {
                    setFailed(false);
                    setAttempt((n) => n + 1);
                  }}
                >
                  画像を再読み込み
                </button>
              </div>
            ) : (
              <Image
                key={attempt}
                unoptimized
                src={design.imageUrl}
                alt={`この提案の制作に使った承認済みデザイン第${design.version}版`}
                width={design.width}
                height={design.height}
                className={enlarged ? "enlarged" : ""}
                onError={() => setFailed(true)}
              />
            )}
          </section>
          <p className="preview-caption">PC・スマホの切り替えは制作サイトに適用されます。</p>
          <Link className="review-outline" href={design.studioHref}>
            この画像の制作条件・PDFを確認
          </Link>
        </>
      ) : (
        <div className="preview-unavailable">
          <ImageIcon size={28} />
          <strong>この提案の制作元画像を確認できません</strong>
          <p>
            承認画像が紐づいていないか、保存された版・診断・画像が一致していません。デザイン一覧から制作元を確認してください。
          </p>
        </div>
      )}
    </div>
  );
}
