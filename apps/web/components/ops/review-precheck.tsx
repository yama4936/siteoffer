import { Check, X } from "lucide-react";
import { PRECHECK_LABEL, type ProposalPrecheck } from "@/lib/ops/review-precheck";

const ROW_STYLE = {
  display: "flex",
  gap: 11,
  padding: "16px 0",
  borderBottom: "1px solid #e8edf5",
  overflowWrap: "anywhere",
} as const;

function checkedAtText(iso: string) {
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" });
}

/** AIの事前チェック（content.aiCheck）の結果。読み取り専用で、人はここを編集しない */
export function ReviewPrecheck({ precheck }: { precheck: ProposalPrecheck | null }) {
  if (!precheck)
    return (
      <div className="review-checks">
        <div className="review-check-progress" role="status">
          <strong>AIチェック未実施</strong>
          <p>
            この版はAIの事前チェックが済んでいない（または結果を読み取れない）ため、承認できません。差し戻すか、AIチェックの完了を待ってください。
          </p>
        </div>
      </div>
    );
  const ngCount = precheck.items.filter((item) => !item.ok).length;
  return (
    <div className="review-checks">
      <div className="review-check-progress" role="status">
        <strong>{precheck.status === "passed" ? "AIチェック：合格" : `AIチェック：不合格（${ngCount}項目）`}</strong>
        <p>
          {precheck.status === "passed"
            ? "4項目の確認をAIが済ませています。サイトを見比べて、承認か差し戻しを選んでください。"
            : "AIが問題を見つけたため承認できません。内容を確認メモに書いて差し戻してください。"}
        </p>
        <p>
          確認日時：<time dateTime={precheck.checkedAt}>{checkedAtText(precheck.checkedAt)}</time>
        </p>
      </div>
      <ul aria-label="AIチェックの項目">
        {precheck.items.map((item) => (
          <li key={item.key} className={item.ok ? "checked" : ""} style={ROW_STYLE}>
            <span
              className="check-icon"
              style={item.ok ? undefined : { color: "#b42318", borderColor: "#f0b6b0", background: "#fff4f2" }}
              role="img"
              aria-label={item.ok ? "問題なし" : "要確認"}
            >
              {item.ok ? <Check size={16} /> : <X size={16} />}
            </span>
            <span style={{ minWidth: 0 }}>
              <strong>
                {PRECHECK_LABEL[item.key].title}：{item.ok ? "OK" : "NG"}
              </strong>
              <small>{item.summary || PRECHECK_LABEL[item.key].description}</small>
              {item.details.length > 0 && (
                <details>
                  <summary style={{ fontSize: 11, cursor: "pointer", marginTop: 4 }}>
                    詳細（{item.details.length}件）
                  </summary>
                  <ul>
                    {item.details.map((detail, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: The details are a static, read-only list.
                      <li key={i}>
                        <small>{detail}</small>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
