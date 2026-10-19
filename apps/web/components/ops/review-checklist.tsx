import { Check, ChevronRight } from "lucide-react";
import { reviewCheckGuide } from "@/lib/ops/review-check-guide";
import { REVIEW_CHECKS, type ReviewCheckKey, type ReviewValues } from "@/lib/ops/review-draft-types";

export function ReviewChecklist({
  values,
  locked,
  canOpen,
  readOnly,
  idPrefix,
  onChange,
  onOpen,
}: {
  values: ReviewValues;
  locked: boolean;
  canOpen: boolean;
  readOnly: boolean;
  idPrefix: string;
  onChange: (key: ReviewCheckKey, value: boolean) => void;
  onOpen: (key: ReviewCheckKey) => void;
}) {
  const count = REVIEW_CHECKS.filter(([key]) => values[key]).length;
  return (
    <div className="review-checks">
      <div className="review-check-progress" role="status" aria-live="polite">
        <strong>
          {count} / {REVIEW_CHECKS.length}項目を確認済み
        </strong>
        <p>
          {readOnly
            ? "この版の確認記録を表示しています。"
            : count === REVIEW_CHECKS.length
              ? "すべての確認欄にチェックが付いています。"
              : `あと${REVIEW_CHECKS.length - count}項目。内容を確認してからチェックしてください。`}
        </p>
        <p>「確認先」から対応する資料を開けます。開くだけではチェックは付きません。</p>
      </div>
      {REVIEW_CHECKS.map(([key, title, description]) => (
        <fieldset
          className="review-check-row"
          key={key}
          id={`${idPrefix}-${key}-row`}
          tabIndex={-1}
          aria-label={`確認欄：${title}`}
        >
          <label className={values[key] ? "checked" : ""} htmlFor={`${idPrefix}-${key}`}>
            <input
              id={`${idPrefix}-${key}`}
              type="checkbox"
              checked={values[key]}
              disabled={locked}
              onChange={(e) => onChange(key, e.target.checked)}
            />
            <span className="check-icon">
              <Check size={16} />
            </span>
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
          </label>
          <button
            type="button"
            className="review-check-open"
            disabled={!canOpen}
            aria-label={`確認先：${title}`}
            onClick={() => onOpen(key)}
          >
            確認先
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        </fieldset>
      ))}
    </div>
  );
}

export function ReviewCheckGuidance({
  check,
  hasDesign,
  hasDemo,
  returnTargetId,
}: {
  check: ReviewCheckKey;
  hasDesign: boolean;
  hasDemo: boolean;
  returnTargetId: string;
}) {
  const guide = reviewCheckGuide(check, hasDesign);
  return (
    <>
      <h3>{guide.title}</h3>
      <p>{guide.description}</p>
      {guide.requiresPreview && !hasDemo && (
        <p className="review-check-unavailable">
          この提案には制作サイトのプレビューがありません。表示や動作を確認できる状態にしてから判断してください。
        </p>
      )}
      <a href={`#${returnTargetId}`}>確認項目へ戻る →</a>
    </>
  );
}
