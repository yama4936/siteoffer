"use client";
import { ExternalLink, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
export function SitePreview({
  title,
  url,
  original = false,
  device,
}: {
  title: string;
  url: string | null;
  original?: boolean;
  device: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const isFixture = !!url && /\.(test|invalid)(?=[:/]|$)/i.test(url);
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(390);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  const frameWidth = device === "mobile" ? 390 : 1024;
  const scale = Math.min(1, Math.max(1, width) / frameWidth);
  return (
    <div className="site-column">
      <div className="site-label">
        <h3>{title}</h3>
        {!original && <span>非公式のご提案</span>}
        {original && url && (
          <a href={url} target="_blank" rel="noreferrer" aria-label="現在のサイトを別タブで開く">
            <ExternalLink size={14} />
          </a>
        )}
      </div>
      <div className="browser-frame">
        <div className="browser-bar">
          <i />
          <i />
          <i />
          <span>{original ? url || "URL未登録" : "SiteOffer / プレビュー"}</span>
        </div>
        {url && !isFixture ? (
          <div className="site-viewport" ref={viewport}>
            <iframe
              title={title}
              style={{
                width: frameWidth,
                height: 460 / scale,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
              src={url}
              sandbox="allow-same-origin"
              referrerPolicy="no-referrer"
              onLoad={() => setLoaded(true)}
            />
            {!loaded && <span className="preview-loading">読み込み中…</span>}
          </div>
        ) : (
          <div className="preview-unavailable">
            <Globe size={32} />
            <strong>
              {isFixture
                ? "架空デモのため元サイトはありません"
                : original
                  ? "サイトが未登録です"
                  : "提案サイトは準備中です"}
            </strong>
            <p>
              {isFixture
                ? "実際の企業のサイトを登録すると、この欄で比較できます。"
                : original
                  ? "企業情報から公式サイトを設定できます。"
                  : "生成済みの提案がここに表示されます。"}
            </p>
          </div>
        )}
      </div>
      {original && url && (
        <p className="preview-caption">
          表示が制限されている場合は、
          <a href={url} target="_blank" rel="noreferrer">
            別タブで確認
          </a>
          してください。
        </p>
      )}
    </div>
  );
}
