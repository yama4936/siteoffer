import type { VariantProps } from "class-variance-authority";
import { Check } from "lucide-react";
import type * as React from "react";
import { Badge, type badgeVariants } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { label } from "@/lib/ops/format";
import { cn } from "@/lib/utils";

/** 運営画面（企業詳細・契約・納品）で使う小さな見た目の部品 */

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

/** 横並びのフォーム（入力欄とボタンを1行に、狭い画面では折り返す） */
export const inlineFormClass = "flex flex-wrap items-center gap-2";
/** 縦積みのフォーム */
export const stackFormClass = "grid max-w-xl gap-3";
/** 折りたたみ（details）と見出し（summary） */
export const detailsClass = "rounded-lg border bg-card px-4 py-2 [&[open]>summary]:mb-3";
export const summaryClass = "cursor-pointer font-medium text-sm marker:text-muted-foreground";

const SUCCESS = new Set([
  "confirmed",
  "sellable",
  "succeeded",
  "approved",
  "completed",
  "received",
  "paid",
  "published",
  "delivered",
]);
const WARNING = new Set([
  "needs_review",
  "in_review",
  "pending",
  "reported",
  "accrued",
  "awaiting_ops",
  "contract_pending",
  "ops_review",
  "customer_review",
  "changes_requested",
]);
const DESTRUCTIVE = new Set(["failed", "rejected", "cancelled", "refunded", "lost", "excluded", "do_not_contact"]);
const INFO = new Set([
  "running",
  "generating",
  "building",
  "working",
  "negotiating",
  "under_review",
  "scheduled",
  "claimed",
  "ready",
]);

/** 状態の値から Badge の色を決める（完了=緑・要確認=黄・失敗/取消=赤・進行中=青・その他=灰） */
export function statusTone(status: string | null | undefined): BadgeVariant {
  if (!status) return "secondary";
  if (SUCCESS.has(status)) return "success";
  if (WARNING.has(status)) return "warning";
  if (DESTRUCTIVE.has(status)) return "destructive";
  if (INFO.has(status)) return "info";
  return "secondary";
}

/** 状態の表示名を色付きの Badge で出す */
export function StatusBadge({
  map,
  status,
  className,
}: {
  map: Record<string, string>;
  status: string | null | undefined;
  className?: string;
}) {
  return (
    <Badge variant={statusTone(status)} className={className}>
      {label(map, status)}
    </Badge>
  );
}

/** 表の件数ゼロの行 */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="py-6 text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

/** 小見出し（Section の中の h3） */
export function SubHeading({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 className={cn("mt-5 mb-2 font-semibold text-muted-foreground text-sm", className)} {...props} />;
}

/** 進み具合の表示（既にある状態の並びと現在の状態だけを使う） */
export function StepIndicator({
  steps,
  current,
  className,
}: {
  steps: readonly { key: string; label: string }[];
  current: string;
  className?: string;
}) {
  const idx = steps.findIndex((s) => s.key === current);
  return (
    <ol className={cn("flex flex-wrap items-center gap-x-1 gap-y-1.5 text-xs", className)}>
      {steps.map((s, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <li key={s.key} className="flex items-center gap-1" aria-current={active ? "step" : undefined}>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
                done && "border-success/25 bg-success/10 text-success",
                active && "border-primary bg-primary font-medium text-primary-foreground",
                !done && !active && "text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3" aria-hidden="true" /> : null}
              {s.label}
            </span>
            {i < steps.length - 1 ? (
              <span className="text-muted-foreground" aria-hidden="true">
                →
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
