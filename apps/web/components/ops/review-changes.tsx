"use client";

import Link from "next/link";
import { useState } from "react";
import { SitePreview } from "@/components/shell/site-preview";
import type { ReviewComparison } from "@/lib/ops/review-comparison";

export function ReviewChanges({
  comparison,
  currentVersion,
  currentPreview,
  sourceHref,
  device,
}: {
  comparison: ReviewComparison;
  currentVersion: number;
  currentPreview: string | null;
  sourceHref: string;
  device: string;
}) {
  const [showSites, setShowSites] = useState(false);
  const [changedOnly, setChangedOnly] = useState(true);
  if (comparison.status !== "ready")
    return (
      <div className="review-document">
        <h3>前の提案との変更点</h3>
        <p>{comparison.reason}</p>
      </div>
    );
  const partial = comparison.groups.some((g) => g.unavailable);
  return (
    <div className="review-changes">
      <header className="review-change-heading">
        <div>
          <h3>
            第{comparison.sourceVersion}版 → 第{currentVersion}版の変更点
          </h3>
          <p className="review-change-help">
            {comparison.basis === "revision" ? "この制作に使った修正元の提案" : "直前の提案"}
            と、保存された文章・設定を比較しています。
          </p>
        </div>
        <Link className="review-outline" href={sourceHref}>
          比較元の提案を開く
        </Link>
      </header>
      <p className="review-change-summary" role="status">
        <strong>変更 {comparison.changed}項目</strong>
        <span>比較できた項目 {comparison.compared}件</span>
        {partial && <span>一部は比較できません</span>}
      </p>
      <p className="review-change-help">表示用の文章・設定の比較です。表示とリンクも確認してから承認してください。</p>
      {comparison.changed === 0 && (
        <p className="review-change-empty">
          比較できた範囲では、保存データ上の変更はありません。サイトの見た目や動作は別途確認してください。
        </p>
      )}
      <label className="review-change-filter">
        <input type="checkbox" checked={changedOnly} onChange={(event) => setChangedOnly(event.target.checked)} />
        変更した項目だけを表示
      </label>
      {comparison.groups
        .filter((group) => !changedOnly || group.unavailable || group.changes.length > 0)
        .map((group) => (
          <section className="review-change-group" key={group.id}>
            <h4>
              {group.title}
              <span>{group.changes.length}項目の変更</span>
            </h4>
            {group.unavailable && (
              <p className="review-change-warning">
                一方の版に保存されたデータを読み取れず、この範囲の比較は完了していません。各提案を開いて確認してください。
              </p>
            )}
            {group.changes.map((change) => (
              <article className="review-change-item" key={change.key}>
                <h5>{change.label}</h5>
                {change.excerpted && (
                  <p className="review-change-help">
                    長文のため、最初の変更付近を抜粋しています。ほかの変更や全文は各提案の「提案内容」で確認できます。
                  </p>
                )}
                <dl>
                  <div>
                    <dt>変更前 · 第{comparison.sourceVersion}版</dt>
                    <dd>{change.before || "設定なし"}</dd>
                  </div>
                  <div>
                    <dt>変更後 · 第{currentVersion}版</dt>
                    <dd>{change.after || "設定なし"}</dd>
                  </div>
                </dl>
              </article>
            ))}
            {!group.unavailable && !group.changes.length && (
              <p className="review-change-help">保存データ上の変更はありません。</p>
            )}
          </section>
        ))}
      <details className="review-change-sites" onToggle={(event) => setShowSites(event.currentTarget.open)}>
        <summary>制作サイトを並べて確認</summary>
        {showSites && (
          <div className={`site-comparison ${device === "mobile" ? "mobile" : ""}`}>
            <SitePreview
              key={`${comparison.sourceId}:${device}`}
              title={`変更前 · 第${comparison.sourceVersion}版`}
              url={comparison.sourceHasDemo ? `/ops/review/preview/${comparison.sourceId}/index.html` : null}
              device={device}
            />
            <SitePreview
              key={`${currentVersion}:${device}`}
              title={`変更後 · 第${currentVersion}版`}
              url={currentPreview}
              device={device}
            />
          </div>
        )}
      </details>
    </div>
  );
}
