"use client";

import { ArrowRight, ChevronRight, ExternalLink, FileText, Monitor, Search, Smartphone } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useId, useRef, useState, useTransition } from "react";
import { commitReviewDraftAction, loadReviewDraftAction, saveReviewDraftAction } from "@/app/(ops)/ops/review/actions";
import { SitePreview } from "@/components/shell/site-preview";
import { usePersonalDraft } from "@/components/use-personal-draft";
import { PIPELINE_LABEL, PROPOSAL_STATUS_LABEL } from "@/lib/ops/format";
import { reviewCheckGuide } from "@/lib/ops/review-check-guide";
import type { ReviewComparison } from "@/lib/ops/review-comparison";
import type { ReviewDesign } from "@/lib/ops/review-design";
import {
  EMPTY_REVIEW,
  REVIEW_CHECKS,
  type ReviewCheckKey,
  type ReviewCommitInput,
  type ReviewDraftSnapshot,
  type ReviewValues,
} from "@/lib/ops/review-draft-types";
import { ReviewChanges } from "./review-changes";
import { ReviewCheckGuidance, ReviewChecklist } from "./review-checklist";
import { ReviewDesignPreview } from "./review-design-preview";

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
  counts: { all: number; pending: number; ready: number };
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
    design: ReviewDesign | null;
    comparison: ReviewComparison;
  } | null;
};
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
  initialDraft,
  documents,
}: {
  items: Item[];
  selected: Selected | null;
  queue: ReviewQueue;
  initialDraft: ReviewDraftSnapshot;
  documents: ReactNode;
}) {
  function reviewHref(companyId: string, versionId?: string | null) {
    const q = new URLSearchParams(queue.context);
    q.set("company", companyId);
    if (versionId) q.set("version", versionId);
    return `/ops/review?${q}`;
  }
  const [tab, setTab] = useState(
    c?.version?.comparison.status === "ready" && c.version.comparison.basis === "revision" ? "changes" : "compare",
  );
  const [device, setDevice] = useState("desktop");
  const queueItemsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!c?.id || !items.some((item) => item.id === c.id)) return;
    const container = queueItemsRef.current;
    const selected = container?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!container || !selected) return;
    function revealSelected() {
      if (!container || !selected) return;
      const box = container.getBoundingClientRect(),
        target = selected.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      // Reveal the selected item within its own list without moving the page or header.
      if (target.height > box.height || target.top < box.top) container.scrollTop += Math.floor(target.top - box.top);
      else if (target.bottom > box.bottom) container.scrollTop += Math.ceil(target.bottom - box.bottom);
      if (target.width > box.width || target.left < box.left)
        container.scrollLeft += Math.floor(target.left - box.left);
      else if (target.right > box.right) container.scrollLeft += Math.ceil(target.right - box.right);
    }
    revealSelected();
    const observer = new ResizeObserver(revealSelected);
    observer.observe(container);
    observer.observe(selected);
    return () => observer.disconnect();
  }, [c?.id, items]);
  const checkId = useId();
  const [checkGuide, setCheckGuide] = useState<{ key: ReviewCheckKey } | null>(null);
  const guideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (checkGuide) guideRef.current?.focus();
  }, [checkGuide]);
  function openTab(next: string) {
    setCheckGuide(null);
    setTab(next);
  }
  const router = useRouter();
  const version = c?.version;
  const confirmed = version?.note?.startsWith("確認済み：") ? version.note.split("\n")[0] : "";
  const defaults = {
    ...EMPTY_REVIEW,
    ...Object.fromEntries(REVIEW_CHECKS.map(([key, title]) => [key, !!confirmed?.includes(title)])),
  } as ReviewValues;
  const draft = usePersonalDraft(initialDraft, defaults, (revision, values) =>
    saveReviewDraftAction(version!.id, revision, values),
  );
  // History navigation may reuse an older server payload. Reconcile before accepting edits.
  const restoreDraft = useRef(draft.applyStored);
  const [draftLoading, setDraftLoading] = useState(!!version);
  const [draftLoadError, setDraftLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const versionId = version?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry starts another authenticated read for the same proposal.
  useEffect(() => {
    if (!versionId) return;
    let active = true;
    setDraftLoading(true);
    setDraftLoadError("");
    void loadReviewDraftAction(versionId)
      .then((result) => {
        if (!active) return;
        if (result.status === "ok") restoreDraft.current(result.snapshot);
        else setDraftLoadError("最新の下書きを確認できませんでした。接続を確認して再試行してください。");
      })
      .catch(() => {
        if (active) setDraftLoadError("最新の下書きを確認できませんでした。接続を確認して再試行してください。");
      })
      .finally(() => {
        if (active) setDraftLoading(false);
      });
    return () => {
      active = false;
    };
  }, [versionId, loadAttempt]);
  const { note } = draft.values;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [completed, setCompleted] = useState(false);
  const [resultUnknown, setResultUnknown] = useState(false);
  const sending = useRef(false);
  const retryInput = useRef<ReviewCommitInput | null>(null);
  const operationKey = useRef<string | null>(null);
  const content = record(version?.content);
  const revisionSource = c?.versions.find((item) => item.id === record(content.proposalRevision).sourceVersionId);
  const proposal = record(content.proposalText);
  const measures = Array.isArray(proposal.measures) ? proposal.measures.map(record) : [];
  const safeWebsite = c?.website && /^https?:\/\//i.test(c.website) ? c.website : null;
  const preview = version?.hasDemo ? `/ops/review/preview/${version.id}/index.html` : null;
  const visible = items;
  const canReview = version?.status === "in_review" && version.isLatest && !completed;
  const locked = !canReview || pending || !draft.ready || draftLoading || !!draftLoadError || resultUnknown;
  function change(patch: Partial<ReviewValues>) {
    draft.change({ ...draft.latest.current, ...patch });
    setError("");
  }
  function submit(decision: "approved" | "rejected", retry = false) {
    if (
      !c ||
      !version ||
      sending.current ||
      pending ||
      !draft.ready ||
      draftLoading ||
      draftLoadError ||
      draft.conflict ||
      (!retry && (!canReview || resultUnknown))
    )
      return;
    if (!retry && decision === "rejected" && !note.trim()) {
      setError("修正してほしい内容を確認メモに入力してください。");
      return;
    }
    if (!retry && decision === "approved" && REVIEW_CHECKS.some(([key]) => !draft.values[key])) {
      setError("5つの確認項目を確認してください。");
      return;
    }
    sending.current = true;
    draft.cancelPendingSave();
    setError("");
    startTransition(async () => {
      try {
        if (!retry && !(await draft.flush())) return;
        operationKey.current ??= crypto.randomUUID();
        const input =
          retry && retryInput.current
            ? retryInput.current
            : { revision: draft.revision.current, decision, requestKey: operationKey.current };
        retryInput.current = input;
        const result = await commitReviewDraftAction(version.id, input);
        setResultUnknown(false);
        if (result.status === "conflict") draft.showConflict(result.snapshot);
        else if (result.status === "error") setError(result.message);
        else {
          draft.applyStored(result.snapshot, draft.latest.current);
          setCompleted(true);
          setMessage(
            input.decision === "approved"
              ? "提案版を承認しました。販売条件を選ぶと営業可能にできます。"
              : "提案版を差し戻し、修正メモを保存しました。同じ承認画像から再制作できます。",
          );
          router.refresh();
        }
      } catch {
        setResultUnknown(true);
        setError(
          "レビュー結果を確認できませんでした。入力を残しています。同じ操作で結果を確認しても二重には記録されません。",
        );
      } finally {
        sending.current = false;
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
            scroll={false}
            className={queue.view === "pending" ? "active" : ""}
            aria-current={queue.view === "pending" ? "page" : undefined}
          >
            確認待ち {queue.counts.pending}
          </Link>
          <Link
            href={queue.allHref}
            scroll={false}
            className={queue.view === "all" ? "active" : ""}
            aria-current={queue.view === "all" ? "page" : undefined}
          >
            すべて {queue.counts.all}
          </Link>
        </nav>
        <div className="queue-items" ref={queueItemsRef}>
          {visible.map((i) => (
            <Link
              key={i.id}
              href={reviewHref(i.id, i.versionId)}
              scroll={false}
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
          {queue.page > 1 ? (
            <Link href={queue.previousHref} scroll={false}>
              前の20社
            </Link>
          ) : (
            <span />
          )}
          <span>
            {queue.page} / {queue.pages}ページ · {queue.total}社
          </span>
          {queue.page < queue.pages ? (
            <Link href={queue.nextHref} scroll={false}>
              次の20社
            </Link>
          ) : (
            <span />
          )}
        </nav>
        {c && !items.some((i) => i.id === c.id) && (
          <p className="queue-empty">表示中の案件は、この一覧条件には含まれていません。</p>
        )}
        <nav className="queue-actions" aria-label="案件の操作">
          <Link href={`/ops/review/ready?${new URLSearchParams({ q: queue.query })}`} className="queue-all">
            営業への引き継ぎ · {queue.counts.ready}社 <ChevronRight size={17} />
          </Link>
          <Link href="/ops/discovery" className="queue-all">
            案件一覧を見る <ChevronRight size={17} />
          </Link>
        </nav>
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
              <Link className="review-outline" href={version?.design?.studioHref ?? `/ops/designs?company=${c.id}`}>
                {version?.design ? "制作元の画像・PDF" : "デザイン一覧"}
              </Link>
              {version?.status === "approved" && !!content.designVersionId && (
                <a className="review-outline" href={`/ops/proposals/${version.id}/pdf`}>
                  提案PDFを保存
                </a>
              )}
            </header>
            {content.fixedSample === true && !preview && (
              <div className="review-version-notice" role="note">
                <strong>動作確認用の提案です</strong>
                <p>改善案のサイトはまだ作成していないため、準備中と表示しています。</p>
              </div>
            )}
            {version && !version.isLatest && (
              <div className="review-version-notice" role="status">
                過去の提案版を表示しています。この版の承認・差し戻しはできません。
                <Link href={reviewHref(c.id, c.versions[0]?.id)}>最新版を開く</Link>
              </div>
            )}
            {revisionSource && (
              <div className="review-version-notice" role="status">
                提案 第{revisionSource.version}版の修正メモを引き継いだ制作です。
                <Link href={reviewHref(c.id, revisionSource.id)}>修正元の提案を確認</Link>
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
                  ["design", "画像案と比較"],
                  ["changes", "前の提案との変更点"],
                  ["proposal", "提案内容"],
                  ["assets", "企業情報・素材"],
                  ["history", "履歴"],
                ].map(([id, title]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={tab === id}
                    className={tab === id ? "active" : ""}
                    onClick={() => openTab(id!)}
                  >
                    {title}
                  </button>
                ))}
              </div>
              {(tab === "compare" || tab === "design" || tab === "changes") && (
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
              {checkGuide && (
                <section ref={guideRef} tabIndex={-1} className="review-check-guide" aria-label="確認項目の案内">
                  <ReviewCheckGuidance
                    check={checkGuide.key}
                    hasDesign={!!version?.design}
                    hasDemo={!!version?.hasDemo}
                    returnTargetId={`${checkId}-${checkGuide.key}-row`}
                  />
                </section>
              )}
              {tab === "changes" && version && (
                <ReviewChanges
                  comparison={version.comparison}
                  currentVersion={version.version}
                  currentPreview={preview}
                  sourceHref={
                    version.comparison.status === "ready" ? reviewHref(c.id, version.comparison.sourceId) : "#"
                  }
                  device={device}
                />
              )}
              {tab === "design" && (
                <>
                  <div className="review-design-intro">
                    <h3>承認した方向性を、制作サイトで確認</h3>
                    <p>
                      {version?.design
                        ? `提案 第${version.version}版の制作元を表示しています。文字・余白・配色・写真・問い合わせ導線を見比べ、違いは確認メモに残してください。`
                        : "この提案の制作元画像を確認できないため、画像との比較はできません。デザイン一覧で制作元を確認してください。"}
                    </p>
                  </div>
                  <div className={`site-comparison ${device === "mobile" ? "mobile" : ""}`}>
                    <ReviewDesignPreview design={version?.design ?? null} />
                    <SitePreview
                      key={`${version?.id}:${device}:design`}
                      title="制作サイト"
                      url={preview}
                      device={device}
                    />
                  </div>
                </>
              )}
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
              {tab === "proposal" &&
                (documents || (
                  <div className="review-document">
                    <p>この版の資料はまだありません。</p>
                  </div>
                ))}
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
            <ReviewChecklist
              values={draft.values}
              locked={locked}
              canOpen={!!version}
              readOnly={!canReview}
              idPrefix={checkId}
              onChange={(key, value) => change({ [key]: value })}
              onOpen={(key) => {
                setTab(reviewCheckGuide(key, !!version?.design).tab);
                setCheckGuide({ key });
              }}
            />
            <div className="review-note">
              <label htmlFor="review-note">確認メモ</label>
              <textarea
                id="review-note"
                value={note}
                maxLength={4000}
                onChange={(e) => change({ note: e.target.value })}
                placeholder="営業に伝えること、修正してほしい内容を入力"
                disabled={locked}
              />
            </div>
            {version && (
              <section className="review-draft-panel" aria-label="レビューの下書き">
                <p role="status">
                  {draftLoading
                    ? "最新の下書きを確認中…"
                    : message || (!canReview && !draft.hasDraft ? "この提案版のレビューは閲覧のみです" : draft.status)}
                </p>
                {draftLoadError && (
                  <div role="alert">
                    <p>{draftLoadError}</p>
                    <button type="button" onClick={() => setLoadAttempt((n) => n + 1)}>
                      下書きの読み込みを再試行
                    </button>
                  </div>
                )}
                <small>
                  自分専用・この提案版だけの下書きです。承認や修正依頼をするまで、営業・他の担当者には共有されません。
                </small>
                <small>{note.length} / 4000文字</small>
                {draft.hasDraft && !draft.conflict && !resultUnknown && (
                  <button
                    type="button"
                    disabled={pending || draftLoading || !!draftLoadError}
                    onClick={() => {
                      if (!window.confirm("この提案版の自分の下書きを破棄しますか？確定済みのレビューは変わりません。"))
                        return;
                      startTransition(async () => {
                        await draft.discard(defaults);
                      });
                    }}
                  >
                    下書きを破棄
                  </button>
                )}
                {draft.conflict && (
                  <div role="alert" className="review-draft-conflict">
                    <p>別の画面で下書きが更新されています。この画面の入力を残して、保存を止めました。</p>
                    <details>
                      <summary>保存済みの内容を見る</summary>
                      <p>{draft.conflict.values?.note || "（確認メモなし）"}</p>
                      <p>
                        確認済み：
                        {REVIEW_CHECKS.filter(([key]) => draft.conflict?.values?.[key])
                          .map(([, title]) => title)
                          .join("、") || "なし"}
                      </p>
                      {!draft.conflict.values && <p>下書きは破棄済み、またはレビュー確定済みです。</p>}
                    </details>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => draft.applyStored(draft.conflict!, defaults)}
                    >
                      保存済みの内容を使う
                    </button>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() =>
                        startTransition(async () => {
                          await draft.keepMine();
                        })
                      }
                    >
                      この画面の入力で保存する
                    </button>
                  </div>
                )}
                {draft.error && (
                  <div role="alert">
                    <p>{draft.error}</p>
                    {!draft.conflict && draft.dirty() && (
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() =>
                          startTransition(async () => {
                            await draft.flush();
                          })
                        }
                      >
                        下書きの保存を再試行
                      </button>
                    )}
                  </div>
                )}
                {resultUnknown && (
                  <button type="button" disabled={pending} onClick={() => submit(retryInput.current!.decision, true)}>
                    結果を確認して再試行
                  </button>
                )}
              </section>
            )}
            {error && (
              <p className="review-error" role="alert">
                {error}
              </p>
            )}
            <div className="review-next">
              <h3>このあと</h3>
              <p>
                {canReview
                  ? "承認後、販売条件を確認して営業へ引き継げます。"
                  : c.pipelineStatus === "sellable"
                    ? "営業可能な案件です。担当・引き継ぎから営業の進行状況を確認できます。"
                    : version?.status === "approved"
                      ? "承認済みです。「販売条件を確認して営業へ」から次へ進めます。"
                      : version?.status === "rejected"
                        ? "修正メモを保存しました。同じ承認画像と元の構成を使って、新しい提案版を制作できます。"
                        : "企業情報と素材を整え、提案を準備してください。"}
              </p>
              {version?.isLatest && version.status === "rejected" && version.design && (
                <Link className="review-outline" href={`${version.design.studioHref}#design-build`}>
                  修正メモを使って再制作へ <ArrowRight size={16} />
                </Link>
              )}
              {version?.note && <p className="previous-note">前回の確認メモ：{version.note}</p>}
            </div>
          </aside>
          <footer className="review-footer">
            <div>
              <strong>
                {version ? `第${version.version}版${version.isLatest ? "を確認中" : "の履歴"}` : "制作準備中"}
              </strong>
              <button type="button" onClick={() => openTab("history")}>
                変更履歴
              </button>
            </div>
            <div>
              <button
                type="button"
                className="review-outline"
                disabled={locked || !!draft.conflict}
                onClick={() => submit("rejected")}
              >
                修正を依頼
              </button>
              {version?.isLatest && version.status === "approved" && c.pipelineStatus !== "sellable" ? (
                <Link className="review-primary" href={`/ops/review/ready?company=${c.id}`}>
                  販売条件を確認して営業へ <ArrowRight size={18} />
                </Link>
              ) : (
                <button
                  type="button"
                  className="review-primary"
                  disabled={locked || !!draft.conflict || REVIEW_CHECKS.some(([key]) => !draft.values[key])}
                  onClick={() => submit("approved")}
                >
                  {pending ? "保存中…" : "提案を承認"}
                  <ArrowRight size={18} />
                </button>
              )}
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
