"use client";

import { ArrowRight, Check, ChevronRight, ExternalLink, FileText, Monitor, Search, Smartphone } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { reviewProposalAction } from "@/app/(ops)/ops/actions";
import { SitePreview } from "@/components/shell/site-preview";
import { PIPELINE_LABEL, PROPOSAL_STATUS_LABEL } from "@/lib/ops/format";

type Item = {
  id: string;
  name: string;
  location: string;
  industry: string | null;
  status: string;
  pending: boolean;
  versionId: string | null;
  version: number | null;
  versionStatus: string | null;
  suppression: string;
};
type ReviewQueue = {
  view: "pending" | "all";
  query: string;
  page: number;
  pages: number;
  total: number;
  counts: { all: number; pending: number };
  context: string;
  pendingHref: string;
  allHref: string;
  previousHref: string;
  nextHref: string;
};
type Selected = {
  pipelineStatus: string;
  id: string;
  name: string;
  location: string;
  industry: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  officialStatus: string;
  assets: { id: string; name: string; allowed: boolean; confirmed: boolean }[];
  versions: { id: string; version: number; status: string; date: string; note: string | null }[];
  version: {
    isLatest: boolean;
    id: string;
    version: number;
    status: string;
    content: unknown;
    hasDemo: boolean;
    note: string | null;
  } | null;
};
const checks = [
  ["会社情報の確認", "会社名・住所・電話番号など"],
  ["画像の利用許諾", "使用する写真・イラストの権利"],
  ["PC・スマホの表示", "各デバイスでの見え方"],
  ["リンク・問い合わせ導線", "メニュー・ボタン・フォームの動作"],
  ["既存機能の引き継ぎ", "ブログ・お知らせなどの更新機能"],
] as const;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function ReviewWorkspace({
  items,
  selected: c,
  queue,
}: {
  items: Item[];
  selected: Selected | null;
  queue: ReviewQueue;
}) {
  function reviewHref(companyId: string, versionId?: string | null) {
    const q = new URLSearchParams(queue.context);
    q.set("company", companyId);
    if (versionId) q.set("version", versionId);
    return `/ops/review?${q}`;
  }
  const [tab, setTab] = useState("compare");
  const [device, setDevice] = useState("desktop");
  const [checked, setChecked] = useState<string[]>(() => {
    const confirmed = c?.version?.note?.startsWith("確認済み：") ? c.version.note.split("\n")[0] : "";
    return checks.map(([title]) => title).filter((title) => confirmed?.includes(title));
  });
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const version = c?.version;
  const content = record(version?.content);
  const proposal = record(content.proposalText);
  const measures = Array.isArray(proposal.measures) ? proposal.measures.map(record) : [];
  const safeWebsite = c?.website && /^https?:\/\//i.test(c.website) ? c.website : null;
  const preview = version?.hasDemo ? `/ops/review/preview/${version.id}/index.html` : null;
  const visible = items;
  const canReview = version?.status === "in_review" && version.isLatest;
  function submit(decision: "approved" | "rejected") {
    if (!c || !version || !canReview) return;
    if (decision === "rejected" && !note.trim()) {
      setError("修正してほしい内容を確認メモに入力してください。");
      return;
    }
    if (decision === "approved" && checked.length !== checks.length) {
      setError("5つの確認項目を確認してください。");
      return;
    }
    const fd = new FormData();
    fd.set("proposalVersionId", version.id);
    fd.set("decision", decision);
    fd.set("returnTo", reviewHref(c.id, version.id));
    fd.set("note", decision === "approved" ? `確認済み：${checked.join("、")}\n${note}` : note);
    setError("");
    startTransition(async () => {
      try {
        await reviewProposalAction(fd);
      } catch (e) {
        if (e instanceof Error && e.message.includes("NEXT_REDIRECT")) throw e;
        setError("処理に失敗しました。状態を確認して再度お試しください。");
      }
    });
  }
  return (
    <div className="review-layout">
      <aside className="review-queue" aria-label="レビュー案件一覧">
        <div className="queue-heading">
          <h1>提案レビュー</h1>
          <span>{queue.counts.pending}</span>
        </div>
        <form className="queue-search" action="/ops/review" method="get" key={queue.query}>
          <Search size={15} aria-hidden="true" />
          <input type="hidden" name="reviewView" value={queue.view} />
          <input
            name="reviewQuery"
            defaultValue={queue.query}
            maxLength={200}
            placeholder="企業名・地域・業種で検索"
            aria-label="レビュー案件を検索"
          />
          <button type="submit">検索</button>
        </form>
        <nav className="queue-filters" aria-label="レビューの表示対象">
          <Link
            href={queue.pendingHref}
            className={queue.view === "pending" ? "active" : ""}
            aria-current={queue.view === "pending" ? "page" : undefined}
          >
            確認待ち {queue.counts.pending}
          </Link>
          <Link
            href={queue.allHref}
            className={queue.view === "all" ? "active" : ""}
            aria-current={queue.view === "all" ? "page" : undefined}
          >
            すべて {queue.counts.all}
          </Link>
        </nav>
        <div className="queue-items">
          {visible.map((i) => (
            <Link
              key={i.id}
              href={reviewHref(i.id, i.versionId)}
              className={`queue-item ${i.id === c?.id ? "selected" : ""}`}
              aria-current={i.id === c?.id ? "page" : undefined}
            >
              <strong>{i.name}</strong>
              <small>
                {i.location || "所在地未確認"} / {i.industry || "業種未確認"}
              </small>
              <span className={`queue-status ${i.pending ? "waiting" : ""}`}>
                <i />
                {i.suppression !== "none"
                  ? "営業抑止中"
                  : i.pending
                    ? "提案確認待ち"
                    : i.versionStatus
                      ? (PROPOSAL_STATUS_LABEL[i.versionStatus] ?? i.versionStatus)
                      : (PIPELINE_LABEL[i.status] ?? i.status)}
              </span>
              {i.version && <small>提案 第{i.version}版</small>}
            </Link>
          ))}
          {visible.length === 0 && <p className="queue-empty">該当する案件はありません。</p>}
        </div>
        <nav aria-label="レビュー案件のページ" className="queue-pagination">
          {queue.page > 1 ? <Link href={queue.previousHref}>前の20社</Link> : <span />}
          <span>
            {queue.page} / {queue.pages}ページ · {queue.total}社
          </span>
          {queue.page < queue.pages ? <Link href={queue.nextHref}>次の20社</Link> : <span />}
        </nav>
        {c && !items.some((i) => i.id === c.id) && (
          <p className="queue-empty">表示中の案件は、この一覧条件には含まれていません。</p>
        )}
        <Link href="/ops/discovery" className="queue-all">
          案件一覧を見る <ChevronRight size={17} />
        </Link>
      </aside>
      {!c ? (
        <div className="review-empty">
          <FileText />
          <h2>
            {queue.query
              ? "条件に合う案件はありません"
              : queue.view === "pending"
                ? "確認待ちの提案はありません"
                : "確認する案件はまだありません"}
          </h2>
          <p>検索条件を変えるか、すべての案件から履歴や制作状況を確認できます。</p>
          <Link href={queue.allHref}>すべての案件を確認</Link>
        </div>
      ) : (
        <>
          <section className="review-content">
            <header className="review-header">
              <div>
                <div className="review-title">
                  <h2>{c.name}</h2>
                  <span className={`review-pill ${canReview ? "waiting" : ""}`}>
                    {version ? (PROPOSAL_STATUS_LABEL[version.status] ?? version.status) : "制作準備中"}
                  </span>
                </div>
                <p>
                  {c.industry || "業種未確認"}
                  <span>•</span>
                  {c.location || "所在地未確認"}
                </p>
                <small>{version ? `提案 第${version.version}版` : "提案はまだありません"}</small>
              </div>
              {preview && (
                <a className="review-outline" href={preview} target="_blank" rel="noreferrer">
                  <ExternalLink size={16} />
                  提案プレビュー
                </a>
              )}
              <Link className="review-outline" href={`/ops/designs?company=${c.id}`}>
                デザイン・提案PDF
              </Link>
              {version?.status === "approved" && !!content.designVersionId && (
                <a className="review-outline" href={`/ops/proposals/${version.id}/pdf`}>
                  提案PDFを保存
                </a>
              )}
            </header>
            {version && !version.isLatest && (
              <div className="review-version-notice" role="status">
                過去の提案版を表示しています。この版の承認・差し戻しはできません。
                <Link href={reviewHref(c.id, c.versions[0]?.id)}>最新版を開く</Link>
              </div>
            )}
            <ol className="review-steps">
              {["情報確認", "制作", "提案確認", "営業・契約", "納品・公開"].map((s, i) => (
                <li key={s} className={i === (c.pipelineStatus === "sellable" ? 3 : version ? 2 : 0) ? "current" : ""}>
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
                  ["assets", "企業情報・素材"],
                  ["history", "履歴"],
                ].map(([id, title]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={tab === id}
                    className={tab === id ? "active" : ""}
                    onClick={() => setTab(id!)}
                  >
                    {title}
                  </button>
                ))}
              </div>
              {tab === "compare" && (
                <div className="device-switch">
                  <button
                    aria-label="PC表示"
                    type="button"
                    aria-pressed={device === "desktop"}
                    className={device === "desktop" ? "active" : ""}
                    onClick={() => setDevice("desktop")}
                  >
                    <Monitor size={16} />
                    PC
                  </button>
                  <button
                    aria-label="スマホ表示"
                    type="button"
                    aria-pressed={device === "mobile"}
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
              {tab === "compare" && (
                <>
                  <div className={`site-comparison ${device === "mobile" ? "mobile" : ""}`}>
                    <SitePreview title="現在のサイト" url={safeWebsite} original device={device} />
                    <SitePreview title="改善案" url={preview} device={device} />
                  </div>
                  <div className="review-highlights">
                    <h3>今回の改善ポイント</h3>
                    {measures.length ? (
                      <ol>
                        {measures.slice(0, 3).map((m, i) => (
                          <li key={text(m.title)}>
                            <b>0{i + 1}</b>
                            <span>{text(m.title)}</span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p>改善提案が作成されると、ここに要点が表示されます。</p>
                    )}
                  </div>
                </>
              )}
              {tab === "proposal" && (
                <div className="review-document">
                  <div className="document-kicker">PROPOSAL / 第{version?.version ?? "—"}版</div>
                  <h3>{c.name}への改善提案</h3>
                  <p>{text(proposal.summary) || "この版の提案文章はまだありません。"}</p>
                  {measures.map((m, i) => (
                    <article key={text(m.title)}>
                      <h4>
                        {String(i + 1).padStart(2, "0")}　{text(m.title)}
                      </h4>
                      <dl>
                        <dt>現在の課題</dt>
                        <dd>{text(m.problem)}</dd>
                        <dt>改善内容</dt>
                        <dd>{text(m.improvement)}</dd>
                      </dl>
                    </article>
                  ))}
                </div>
              )}
              {tab === "assets" && (
                <div className="review-document">
                  <h3>企業情報</h3>
                  <dl className="company-facts">
                    <dt>企業名</dt>
                    <dd>{c.name}</dd>
                    <dt>住所</dt>
                    <dd>{c.address || c.location || "未登録"}</dd>
                    <dt>電話番号</dt>
                    <dd>{c.phone || "未登録"}</dd>
                    <dt>公式サイト</dt>
                    <dd>
                      {safeWebsite ? (
                        <a href={safeWebsite} target="_blank" rel="noreferrer">
                          {safeWebsite}
                        </a>
                      ) : (
                        "未登録"
                      )}
                    </dd>
                  </dl>
                  <h3>画像素材・利用許諾</h3>
                  {c.assets.length ? (
                    c.assets.map((a) => (
                      <div className="asset-row" key={a.id}>
                        <strong>{a.name}</strong>
                        <span>{a.confirmed && a.allowed ? "営業デモで使用可" : "利用許諾の確認が必要"}</span>
                      </div>
                    ))
                  ) : (
                    <p>画像素材は未登録です。使用画像の出所と利用範囲を確認してください。</p>
                  )}
                  <Link
                    className="review-outline"
                    href={`/ops/companies/${c.id}?returnTo=${encodeURIComponent(reviewHref(c.id, version?.id))}`}
                  >
                    企業情報・素材を編集 <ArrowRight size={16} />
                  </Link>
                </div>
              )}
              {tab === "history" && (
                <div className="review-document">
                  <h3>提案の履歴</h3>
                  {c.versions.map((v) => (
                    <Link href={reviewHref(c.id, v.id)} className="version-row" key={v.id}>
                      <span className="version-number">{v.version}</span>
                      <div>
                        <strong>提案 第{v.version}版</strong>
                        <small>
                          {PROPOSAL_STATUS_LABEL[v.status] ?? v.status} ·{" "}
                          {new Date(v.date).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}
                        </small>
                        <p>{v.note || "確認メモはありません"}</p>
                      </div>
                      <ChevronRight size={16} />
                    </Link>
                  ))}
                  {!c.versions.length && <p>提案の履歴はありません。</p>}
                </div>
              )}
            </div>
          </section>
          <aside className="review-inspector">
            <h2>営業前の確認</h2>
            <p>内容を確認して営業へ引き継ぎます</p>
            <div className="review-checks">
              {checks.map(([title, description]) => (
                <label key={title} className={checked.includes(title) ? "checked" : ""}>
                  <input
                    type="checkbox"
                    checked={checked.includes(title)}
                    disabled={!canReview || pending}
                    onChange={(e) =>
                      setChecked(e.target.checked ? [...checked, title] : checked.filter((s) => s !== title))
                    }
                  />
                  <span className="check-icon">
                    <Check size={16} />
                  </span>
                  <span>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                </label>
              ))}
            </div>
            <label className="review-note" htmlFor="review-note">
              確認メモ
              <textarea
                id="review-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="営業に伝えること、修正してほしい内容を入力"
                disabled={!canReview || pending}
              />
            </label>
            {error && (
              <p className="review-error" role="alert">
                {error}
              </p>
            )}
            <div className="review-next">
              <h3>このあと</h3>
              <p>
                {canReview
                  ? "承認後、販売条件・報酬条件を選ぶと営業可能にできます。"
                  : c.pipelineStatus === "sellable"
                    ? "営業可能な案件です。担当・引き継ぎから営業の進行状況を確認できます。"
                    : version?.status === "approved"
                      ? "承認済みです。下の「販売条件を選んで営業可能にする」から次へ進めます。"
                      : "企業情報と素材を整え、提案を準備してください。"}
              </p>
              {version?.note && <p className="previous-note">前回の確認メモ：{version.note}</p>}
            </div>
          </aside>
          <footer className="review-footer">
            <div>
              <strong>
                {version ? `第${version.version}版${version.isLatest ? "を確認中" : "の履歴"}` : "制作準備中"}
              </strong>
              <button type="button" onClick={() => setTab("history")}>
                変更履歴
              </button>
            </div>
            <div>
              <button
                type="button"
                className="review-outline"
                disabled={!canReview || pending}
                onClick={() => submit("rejected")}
              >
                修正を依頼
              </button>
              <button
                type="button"
                className="review-primary"
                disabled={!canReview || pending || checked.length !== checks.length}
                onClick={() => submit("approved")}
              >
                {pending ? "保存中…" : "提案を承認"}
                <ArrowRight size={18} />
              </button>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
