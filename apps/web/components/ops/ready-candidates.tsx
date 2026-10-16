"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { activateSalesCandidateAction } from "@/app/(ops)/ops/review/ready/actions";
import type { SalesReadiness } from "@/lib/ops/sales-readiness";

export function ReadyCandidates({ data }: { data: SalesReadiness }) {
  const router = useRouter();
  const [termsId, setTermsId] = useState("");
  const [confirmation, setConfirmation] = useState<{
    companyId: string;
    companyUpdatedAt: string;
    companyName: string;
    proposalVersionId: string;
    version: number;
    terms: SalesReadiness["terms"][number];
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const c = data.selected;
  const eligible = c?.versionStatus === "approved" && c.status !== "sellable" && c.suppression === "none";
  const terms = data.terms.find((t) => t.id === termsId);
  function href(page: number, company?: string) {
    const q = new URLSearchParams({ page: String(page) });
    if (data.query) q.set("q", data.query);
    if (company) q.set("company", company);
    return `/ops/review/ready?${q}`;
  }
  function confirm() {
    if (!c?.versionId || !c.version || !eligible || !terms?.ready) return;
    setConfirmation({
      companyId: c.id,
      companyUpdatedAt: c.updatedAt,
      companyName: c.name,
      proposalVersionId: c.versionId,
      version: c.version,
      terms,
    });
    setMessage("");
    setFailed(false);
  }
  function activate() {
    if (!confirmation || pending) return;
    const target = confirmation;
    startTransition(async () => {
      try {
        const result = await activateSalesCandidateAction({
          companyId: target.companyId,
          companyUpdatedAt: target.companyUpdatedAt,
          proposalVersionId: target.proposalVersionId,
          productTermsId: target.terms.id,
        });
        setFailed(!result.ok);
        setMessage(result.message);
        if (result.ok) {
          setConfirmation(null);
          setTermsId("");
        }
        router.refresh();
      } catch {
        setFailed(true);
        setMessage("結果を確認できませんでした。確認内容を残しています。同じ対象で再試行しても二重に処理しません。");
      }
    });
  }
  return (
    <div className="sales-ready-page">
      <header>
        <div>
          <p className="sales-ready-kicker">提案承認後の準備</p>
          <h1>営業への引き継ぎ</h1>
          <p>承認済みの提案と販売・報酬条件を確認して、営業が担当できる状態にします。</p>
        </div>
        <Link href="/ops/review">提案レビューへ戻る</Link>
      </header>
      <div className="sales-ready-layout">
        <aside aria-label="営業への引き継ぎ候補" className="sales-ready-list">
          <h2>
            引き継ぎ待ち <span>{data.total}社</span>
          </h2>
          <form action="/ops/review/ready" method="get" key={data.query}>
            <input
              name="q"
              defaultValue={data.query}
              maxLength={200}
              placeholder="企業名・地域・業種"
              aria-label="引き継ぎ候補を検索"
            />
            <button type="submit">検索</button>
          </form>
          {data.query && <Link href="/ops/review/ready">検索を解除</Link>}
          <div className="sales-ready-items">
            {data.items.map((item) => (
              <Link key={item.id} href={href(data.page, item.id)} aria-current={item.id === c?.id ? "page" : undefined}>
                <strong>{item.name}</strong>
                <small>
                  {item.location || "所在地未確認"} · {item.industry || "業種未確認"}
                </small>
                <span>第{item.version}版 · 承認済み</span>
              </Link>
            ))}
          </div>
          {!data.items.length && <p>該当する引き継ぎ待ちの案件はありません。</p>}
          <nav aria-label="引き継ぎ候補のページ">
            {data.page > 1 ? <Link href={href(data.page - 1)}>前の20社</Link> : <span />}
            <span>
              {data.page} / {data.pages}ページ
            </span>
            {data.page < data.pages ? <Link href={href(data.page + 1)}>次の20社</Link> : <span />}
          </nav>
        </aside>
        <section className="sales-ready-detail" aria-label="営業へ引き継ぐ案件">
          {message && (
            <p role={failed ? "alert" : "status"} className={failed ? "sales-ready-error" : "sales-ready-success"}>
              {message}
            </p>
          )}
          {c ? (
            <>
              <h2>{c.name}</h2>
              <p>
                {c.location || "所在地未確認"} · {c.industry || "業種未確認"}
              </p>
              <div className="sales-ready-links">
                <Link href={`/ops/review?company=${c.id}${c.versionId ? `&version=${c.versionId}` : ""}`}>
                  提案 第{c.version ?? "—"}版を確認
                </Link>
                <Link href={`/ops/companies/${c.id}?returnTo=${encodeURIComponent(href(data.page, c.id))}`}>
                  企業情報を確認
                </Link>
              </div>
              {!eligible && (
                <p className={c.status === "sellable" ? "sales-ready-success" : "sales-ready-error"}>
                  {c.status === "sellable"
                    ? "この企業は営業可能です。"
                    : c.suppression !== "none"
                      ? "この企業は営業抑止中です。企業情報を確認してください。"
                      : "最新版の提案確認が必要です。提案レビューを開いてください。"}
                </p>
              )}
              {eligible && (
                <>
                  <label htmlFor="ready-terms">販売条件・報酬条件</label>
                  <select
                    id="ready-terms"
                    value={termsId}
                    disabled={pending || !!confirmation}
                    onChange={(e) => {
                      setTermsId(e.target.value);
                      setMessage("");
                    }}
                  >
                    <option value="">条件の版を選んでください</option>
                    {data.terms.map((t) => (
                      <option value={t.id} key={t.id} disabled={!t.ready}>
                        {t.version} · {t.name} · {t.price}
                        {t.ready ? "" : "（価格・報酬が未設定）"}
                      </option>
                    ))}
                  </select>
                  {!data.terms.some((t) => t.ready) && (
                    <p className="sales-ready-error">
                      使える販売条件がありません。<Link href="/ops/contracts">商品条件を設定してください。</Link>
                    </p>
                  )}
                  {terms && !confirmation && (
                    <dl className="sales-ready-terms">
                      <dt>初期費用</dt>
                      <dd>{terms.price}</dd>
                      <dt>月額</dt>
                      <dd>{terms.monthlyFee}</dd>
                      <dt>営業報酬</dt>
                      <dd>{terms.reward}</dd>
                      <dt>提供範囲</dt>
                      <dd>{terms.scope}</dd>
                    </dl>
                  )}
                  {!confirmation && (
                    <button
                      type="button"
                      className="review-primary"
                      disabled={!terms?.ready || pending}
                      onClick={confirm}
                    >
                      引き継ぎ内容を確認
                    </button>
                  )}
                </>
              )}
              {confirmation && (
                <section className="sales-ready-confirmation" aria-label="営業への引き継ぎ内容">
                  <h3>この内容で営業可能にします</h3>
                  <dl className="sales-ready-terms">
                    <dt>企業</dt>
                    <dd>{confirmation.companyName}</dd>
                    <dt>提案版</dt>
                    <dd>第{confirmation.version}版</dd>
                    <dt>条件の版</dt>
                    <dd>
                      {confirmation.terms.version} · {confirmation.terms.name}
                    </dd>
                    <dt>初期費用 / 月額</dt>
                    <dd>
                      {confirmation.terms.price} / {confirmation.terms.monthlyFee}
                    </dd>
                    <dt>営業報酬</dt>
                    <dd>{confirmation.terms.reward}</dd>
                    <dt>提供範囲</dt>
                    <dd>{confirmation.terms.scope}</dd>
                  </dl>
                  <p>確定すると営業の企業一覧に表示されます。</p>
                  <div className="sales-ready-buttons">
                    <button
                      type="button"
                      className="review-outline"
                      disabled={pending}
                      onClick={() => {
                        setConfirmation(null);
                        setMessage("");
                      }}
                    >
                      選び直す
                    </button>
                    <button type="button" className="review-primary" disabled={pending} onClick={activate}>
                      {pending ? "反映中…" : failed ? "同じ内容で再試行" : "営業可能にする"}
                    </button>
                  </div>
                </section>
              )}
            </>
          ) : (
            <div className="sales-ready-empty">
              <h2>{data.query ? "条件に合う案件はありません" : "引き継ぎ待ちの案件はありません"}</h2>
              <p>提案を承認すると、ここから販売条件の確認へ進めます。</p>
              <Link href="/ops/review">確認待ちの提案を見る</Link>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
