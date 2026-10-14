import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { label as labelOf } from "@/lib/ops/format";

/** 運営画面の表示部品（概要・収集・レビュー・担当・設定・診断結果で使う） */

type Tone = "success" | "warning" | "destructive" | "info" | "secondary" | "outline";

/** 状態の値 → バッジの色。表示の文言は各 *_LABEL を使う */
const STATUS_TONE: Record<string, Tone> = {
  // 完了・確定
  succeeded: "success",
  approved: "success",
  sellable: "success",
  confirmed: "success",
  completed: "success",
  evaluated: "success",
  // 運営の確認・判断が必要
  needs_review: "warning",
  in_review: "warning",
  awaiting_ops: "warning",
  contract_pending: "warning",
  on_hold: "warning",
  unevaluable: "warning",
  // 失敗・停止
  failed: "destructive",
  rejected: "destructive",
  suspended: "destructive",
  // 処理中
  running: "info",
  generating: "info",
  collecting: "info",
  scoring: "info",
  working: "info",
  negotiating: "info",
};

export function statusTone(value: string | null | undefined): Tone {
  return (value && STATUS_TONE[value]) || "secondary";
}

/** 状態をバッジで表示する。labels があればその文言、なければ children を表示する */
export function StatusBadge({
  value,
  labels,
  tone,
  children,
  className,
}: {
  value: string | null | undefined;
  labels?: Record<string, string>;
  tone?: Tone;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Badge variant={tone ?? statusTone(value)} className={className}>
      {children ?? (labels ? labelOf(labels, value) : (value ?? "—"))}
    </Badge>
  );
}

/** 表の行の中などで、入力欄とボタンを横に並べるフォーム */
export const inlineFormClass = "flex flex-wrap items-center gap-2";
