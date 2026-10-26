"use client";
import { ExternalLink, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { loadSitePreview, type PreviewLoadState } from "@/lib/client/site-preview";

function PreviewViewport({ title, url, device, retry }: { title: string; url: string; device: string; retry(): void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(390);
  const [status, setStatus] = useState<PreviewLoadState>("loading");
  useEffect(() => {
    const target = frame.current;
    if (target) return loadSitePreview(target, url, setStatus);
  }, [url]);
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
    <div className="site-viewport" ref={viewport} aria-busy={status === "loading"}>
      <iframe
        ref={frame}
        title={title}
        style={{ width: frameWidth, height: 460 / scale, transform: `scale(${scale})`, transformOrigin: "top left" }}
        loading="eager"
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
      />
      {status === "loading" && (
        <span className="preview-loading" role="status">
          読み込み中…
        </span>
      )}
      {status === "unavailable" && (
        <div className="preview-status" role="status">
          <strong>枠内の表示を確認できません</strong>
          <p>再読み込みするか、下のリンクから別タブで確認してください。</p>
          <button type="button" onClick={retry} aria-label={`${title}を再読み込み`}>
            再読み込み
          </button>
        </div>
      )}
    </div>
  );
}

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
  const [attempt, setAttempt] = useState(0);
  const isFixture = !!url && /\.(test|invalid)(?=[:/]|$)/i.test(url);
  return (
    <div className="site-column">
      <div className="site-label">
        <h3>{title}</h3>
        {!original && <span>非公式のご提案</span>}
        {original && url && !isFixture && (
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
          <PreviewViewport
            key={`${url}:${attempt}`}
            title={title}
            url={url}
            device={device}
            retry={() => setAttempt((n) => n + 1)}
          />
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
      {url && !isFixture && (
        <p className="preview-caption">
          枠内で表示できない場合は、
          <a href={url} target="_blank" rel="noreferrer" aria-label={`${title}を別タブで確認`}>
            別タブで確認
          </a>
          してください。
        </p>
      )}
    </div>
  );
}
