"use client";
import { ArrowRight, CheckCircle2, ExternalLink, Monitor, Smartphone } from "lucide-react";
import { type ReactNode, useState } from "react";
import { SitePreview } from "@/components/shell/site-preview";
import { usePreviewDevice } from "@/components/shell/use-preview-device";

type Props = {
  company: {
    id: string;
    name: string;
    location: string;
    industry: string | null;
    phone: string | null;
    version: number | null;
    pdf?: string | null;
    mock?: boolean;
    assignment: string;
    website: string | null;
    preview: string | null;
  };
  queue: ReactNode;
  highlights: string[];
  action: ReactNode;
  sharing: ReactNode;
  proposal: ReactNode;
  info: ReactNode;
  audit: ReactNode;
  terms: ReactNode;
  script: ReactNode;
};
export function CompanyWorkspace({
  company: c,
  queue,
  highlights,
  action,
  sharing,
  proposal,
  info,
  audit,
  terms,
  script,
}: Props) {
  const [tab, setTab] = useState("compare");
  const [device, setDevice] = usePreviewDevice();
  return (
    <div className="review-layout sales-case">
      <aside className="review-queue">{queue}</aside>
      <section className="review-content">
        <header className="review-header">
          <div>
            <div className="review-title">
              <h2>{c.name}</h2>
              <span className="review-pill">{c.assignment === "mine" ? "自分が担当中" : "営業候補"}</span>
            </div>
            <p>
              {c.industry ?? "業種未確認"}
              <span>•</span>
              {c.location}
            </p>
            <small>{c.version ? `提案 第${c.version}版 ・ 運営レビュー済み` : "提案準備中"}</small>
          </div>
          <div className="review-header-actions">
            {c.pdf && (
              <a href={c.pdf} className="review-outline">
                提案PDFをダウンロード
              </a>
            )}
            {c.preview && (
              <a href={c.preview} target="_blank" rel="noreferrer" className="review-outline">
                <ExternalLink size={16} />
                提案プレビュー
              </a>
            )}
          </div>
        </header>
        {c.mock && !c.preview && (
          <p className="sales-fixture-notice">
            架空データの動作検証です。改善案のサイトはまだ作成していないため、準備中と表示しています。
          </p>
        )}
        <ol className="review-steps">
          {["提案確認", "担当確保", "商談", "契約", "納品・公開"].map((s, i) => (
            <li key={s} className={i === (c.assignment === "mine" ? 1 : 0) ? "current" : ""}>
              <span>{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <div className="review-toolbar">
          <div className="review-tabs">
            {[
              ["compare", "サイト比較"],
              ["proposal", "提案内容"],
              ["info", "企業情報"],
              ["audit", "診断結果"],
              ["terms", "販売条件"],
              ["script", "電話台本"],
            ].map(([id, label]) => (
              <button
                type="button"
                key={id}
                aria-pressed={tab === id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id!)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "compare" && (
            <div className="device-switch">
              <button
                type="button"
                aria-label="PC表示"
                className={device === "desktop" ? "active" : ""}
                onClick={() => setDevice("desktop")}
              >
                <Monitor size={16} />
                PC
              </button>
              <button
                type="button"
                aria-label="スマホ表示"
                className={device === "mobile" ? "active" : ""}
                onClick={() => setDevice("mobile")}
              >
                <Smartphone size={16} />
                スマホ
              </button>
            </div>
          )}
        </div>
        <div className="review-panel">
          {tab === "compare" ? (
            <>
              <div className={`site-comparison ${device === "mobile" ? "mobile" : ""}`}>
                <SitePreview
                  title="現在のサイト"
                  url={c.website && /^https?:\/\//.test(c.website) ? c.website : null}
                  original
                  device={device}
                />
                <SitePreview title="改善案" url={c.preview} device={device} />
              </div>
              <div className="review-highlights">
                <h3>今回の改善ポイント</h3>
                {highlights.length ? (
                  <ol>
                    {highlights.slice(0, 3).map((h, i) => (
                      <li key={h}>
                        <b>0{i + 1}</b>
                        <span>{h}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>改善提案は準備中です。</p>
                )}
              </div>
            </>
          ) : (
            <div className="sales-case-document">{{ proposal, info, audit, terms, script }[tab]}</div>
          )}
        </div>
      </section>
      <aside className="review-inspector sales-case-inspector">
        <h2>商談の準備</h2>
        <p>提案の内容を確認して、次のアクションへ</p>
        <div className="sales-side-section">
          <div className="side-state">
            {c.version ? <CheckCircle2 size={22} /> : null}
            <strong>{c.version ? "運営レビュー済みの提案" : "提案準備中"}</strong>
          </div>
          <p>企業に伝える内容と未確認事項を、提案内容・診断結果で確認できます。</p>
        </div>
        <div className="sales-side-section">
          <h3>連絡先</h3>
          <div className="side-fact">
            <small>代表電話</small>
            <strong>{c.phone ?? "未登録"}</strong>
          </div>
          <div className="side-fact">
            <small>所在地</small>
            <strong>{c.location || "未登録"}</strong>
          </div>
          <button type="button" className="review-outline" onClick={() => setTab("script")}>
            電話台本を確認
            <ArrowRight size={15} />
          </button>
        </div>
        <div className="sales-side-section share-controls">
          <h3>顧客への提案共有</h3>
          {sharing}
        </div>
        <div className="sales-side-section">
          <h3>このあと</h3>
          <p>
            {c.assignment === "mine"
              ? "担当案件から活動記録・次回対応・成約報告を管理できます。"
              : "担当を確保してから、提案リンクの共有や営業活動を進められます。"}
          </p>
          <p>提案は非公式です。効果や成約を保証する表現は避けてください。</p>
        </div>
      </aside>
      <footer className="review-footer sales-case-footer">
        <div>
          <strong>{c.version ? `提案 第${c.version}版` : "提案準備中"}</strong>
          <button type="button" onClick={() => setTab("terms")}>
            販売条件を確認
          </button>
        </div>
        <div>{action}</div>
      </footer>
    </div>
  );
}
