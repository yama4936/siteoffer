"use client";
import type { ImageSubmissionView } from "@siteoffer/core";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { controlClass } from "@/components/ui/input";
import {
  type DetailKey,
  detailKeys,
  type MaterialDraft,
  type MergeChoices,
  materialConflicts,
  mergeMaterialDraft,
} from "./merge";
import { materialStatus, rightsLabels } from "./shared";

export function useComparisonFocus(
  form: RefObject<HTMLFormElement | null>,
  open: boolean,
  version: number,
  firstField: string,
) {
  const previous = useRef({ open: false, version: 0 });
  useEffect(() => {
    if (previous.current.open && !open) {
      const selector = previous.current.version !== version ? `[name="${firstField}"]` : "[data-material-compare]";
      form.current?.querySelector<HTMLElement>(selector)?.focus();
    }
    previous.current = { open, version };
  }, [form, open, version, firstField]);
}
function ComparisonTitle({ children }: { children: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <h3 ref={heading} tabIndex={-1} className="font-semibold">
      {children}
    </h3>
  );
}

const labels: Record<DetailKey, string> = {
  label: "素材名",
  rightsBasis: "画像を提供できる根拠",
  rightsNote: "権利と使い方の説明",
  requestedDemo: "営業デモでの利用",
  requestedProduction: "本番サイトでの利用",
};
function detailText(key: DetailKey, value: MaterialDraft[DetailKey]) {
  if (typeof value === "boolean") return value ? "許可する" : "許可しない";
  if (key === "rightsBasis") return rightsLabels[value as MaterialDraft["rightsBasis"]];
  return value || "（未入力）";
}
function draftText(draft: MaterialDraft) {
  return detailKeys.map((key) => `${labels[key]}：${detailText(key, draft[key])}`).join("\n\n");
}
function SnapshotDiff({ before, latest }: { before: ImageSubmissionView; latest: ImageSubmissionView }) {
  const rows = [
    { label: "確認状況", before: materialStatus[before.status], after: materialStatus[latest.status] },
    ...detailKeys
      .filter((key) => before[key] !== latest[key])
      .map((key) => ({
        label: labels[key],
        before: detailText(key, before[key]),
        after: detailText(key, latest[key]),
      })),
    ...(before.reviewNote !== latest.reviewNote
      ? [{ label: "運営の確認内容", before: before.reviewNote || "（なし）", after: latest.reviewNote || "（なし）" }]
      : []),
    ...(before.allowSalesDemo !== latest.allowSalesDemo || before.allowProduction !== latest.allowProduction
      ? [
          {
            label: "現在の利用許可",
            before:
              [before.allowSalesDemo && "営業デモ", before.allowProduction && "本番サイト"]
                .filter(Boolean)
                .join("・") || "なし",
            after:
              [latest.allowSalesDemo && "営業デモ", latest.allowProduction && "本番サイト"]
                .filter(Boolean)
                .join("・") || "なし",
          },
        ]
      : []),
  ];
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        入力開始時：第{before.revision}版 → 取得した最新：第{latest.revision}版
      </p>
      {rows.map((row) => (
        <div key={row.label} className="rounded-lg border bg-white p-3">
          <h4 className="text-sm font-semibold">{row.label}</h4>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <div>
              <p className="text-xs text-slate-500">入力開始時</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{row.before}</p>
            </div>
            <div>
              <p className="text-xs text-blue-700">取得した最新</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{row.after}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
function RetainedText({ text, label }: { text: string; label: string }) {
  const id = useId(),
    [message, setMessage] = useState("");
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea id={id} readOnly value={text} className={`${controlClass} min-h-32`} />
      <Button
        type="button"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setMessage("入力をコピーしました");
          } catch {
            setMessage("コピーできませんでした。上の欄を選択してコピーしてください。");
          }
        }}
      >
        入力をコピー
      </Button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
type CommonProps = {
  before: ImageSubmissionView;
  latest: ImageSubmissionView;
  onClose: () => void;
  onFinish: () => void;
};
export function CustomerMaterialComparison({
  before,
  latest,
  draft,
  onResume,
  onClose,
  onFinish,
}: CommonProps & { draft: MaterialDraft; onResume: (draft: MaterialDraft) => void }) {
  const [choices, setChoices] = useState<MergeChoices>({}),
    id = useId();
  const conflicts = materialConflicts(before, draft, latest),
    merged = mergeMaterialDraft(before, draft, latest, choices);
  const editable = latest.status === "pending" || latest.status === "needs_changes";
  return (
    <section
      aria-label="最新の内容と入力の比較"
      className="mt-5 space-y-4 rounded-xl border border-blue-200 bg-blue-50 p-4"
    >
      <ComparisonTitle>最新の内容と入力を比較</ComparisonTitle>
      <SnapshotDiff before={before} latest={latest} />
      <RetainedText text={draftText(draft)} label="現在の入力（未保存）" />
      {editable ? (
        <>
          <p className="text-sm leading-7">
            片方だけで変更した項目は両方残します。同じ項目を別々に変更した場合は、残す内容を選んでください。まだ送信はしません。
          </p>
          {conflicts.map((key) => (
            <fieldset key={key} className="space-y-2 rounded-lg border bg-white p-3">
              <legend className="px-1 text-sm font-semibold">{labels[key]}に両方の変更があります</legend>
              {(["mine", "latest"] as const).map((choice) => (
                <label key={choice} className="flex items-start gap-2 text-sm leading-6">
                  <input
                    type="radio"
                    name={`${id}-${key}`}
                    className="mt-1"
                    checked={choices[key] === choice}
                    onChange={() => setChoices((previous) => ({ ...previous, [key]: choice }))}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{choice === "mine" ? "自分の入力を残す" : "最新の内容を使う"}</span>
                    <span className="block whitespace-pre-wrap break-words">
                      {detailText(key, choice === "mine" ? draft[key] : latest[key])}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
          {!merged && <p className="text-sm text-amber-800">両方で変更した項目の選択が必要です。</p>}
          <Button
            type="button"
            disabled={!merged}
            onClick={() => {
              if (merged) onResume(merged);
            }}
          >
            入力を引き継いで編集を再開
          </Button>
          <p className="text-xs leading-6 text-slate-600">
            再開後に内容と利用許可を見直し、確認チェックを付けて送信してください。
          </p>
        </>
      ) : (
        <p role="status" className="text-sm leading-7">
          現在は{materialStatus[latest.status]}のため、説明を変更できません。未保存の入力は上の欄からコピーできます。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          比較を閉じて入力に戻る
        </Button>
        {!editable && (
          <Button type="button" variant="outline" className="h-auto whitespace-normal" onClick={onFinish}>
            入力を破棄して最新状況を表示
          </Button>
        )}
      </div>
    </section>
  );
}
export function OperatorMaterialComparison({
  before,
  latest,
  note,
  onResume,
  onClose,
  onFinish,
}: CommonProps & { note: string; onResume: () => void }) {
  return (
    <section
      aria-label="最新の提出と確認メモの比較"
      className="mt-5 space-y-4 rounded-xl border border-blue-200 bg-blue-50 p-4"
    >
      <ComparisonTitle>最新の提出内容を確認</ComparisonTitle>
      <SnapshotDiff before={before} latest={latest} />
      <RetainedText text={note} label="確認メモ（未保存）" />
      {latest.status === "pending" ? (
        <>
          <p className="text-sm leading-7">
            メモを引き継ぎます。最新の画像・説明に合わせて、確認結果・利用用途・確認チェックを選び直してください。まだ保存はしません。
          </p>
          <Button type="button" onClick={onResume}>
            メモを引き継いで確認を再開
          </Button>
        </>
      ) : (
        <p role="status" className="text-sm leading-7">
          現在は{materialStatus[latest.status]}
          のため、この提出の確認はできません。未保存のメモは上の欄からコピーできます。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          比較を閉じて入力に戻る
        </Button>
        {latest.status !== "pending" && (
          <Button type="button" variant="outline" className="h-auto whitespace-normal" onClick={onFinish}>
            入力を破棄して最新状況を表示
          </Button>
        )}
      </div>
    </section>
  );
}
