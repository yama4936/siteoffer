import type { ReactNode } from "react";
import { type GroupableFinding, groupFindings } from "@/lib/audit/finding-groups";

/**
 * 診断の項目を「要改善」（開いて表示）と「問題なし」「評価できなかった・対象外」（閉じて表示）に分けて並べる。
 * 項目の見せ方（一覧・表）は呼び出し側の renderList に任せる。開閉は標準の details/summary で、スクリプトに依存しない。
 */
export function FindingSections<T extends GroupableFinding>({
  findings,
  renderList,
}: {
  findings: readonly T[];
  renderList: (items: T[]) => ReactNode;
}) {
  if (findings.length === 0) return <p>診断項目の結果はまだありません。</p>;
  const { needsWork, ok, other } = groupFindings(findings);
  return (
    <div className="finding-sections">
      <h3>改善が必要な項目（{needsWork.length}件）</h3>
      {needsWork.length > 0 ? renderList(needsWork) : <p>改善が必要と判定された項目はありません。</p>}
      {ok.length > 0 && (
        <details className="finding-group">
          <summary>問題なしの項目（{ok.length}件）</summary>
          {renderList(ok)}
        </details>
      )}
      {other.length > 0 && (
        <details className="finding-group">
          <summary>評価できなかった・対象外の項目（{other.length}件）</summary>
          <p className="sub">評価できなかった項目は低評価には含めていません。</p>
          {renderList(other)}
        </details>
      )}
    </div>
  );
}
