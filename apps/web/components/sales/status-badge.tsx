// 営業画面の状態バッジ。状態の意味から色を選ぶだけで、状態の判定はしない
import { Badge } from "@/components/ui/badge";
import { ASSIGNMENT_STATUS_LABELS, CONTRACT_STATUS_LABELS, REWARD_STATUS_LABELS } from "@/lib/sales/labels";

type Variant = "info" | "success" | "warning" | "destructive" | "secondary";

const ASSIGNMENT_VARIANT: Record<string, Variant> = {
  claimed: "info",
  working: "info",
  negotiating: "info",
  awaiting_ops: "warning",
  contract_pending: "warning",
  completed: "success",
  released: "secondary",
  lost: "destructive",
};

const CONTRACT_VARIANT: Record<string, Variant> = {
  reported: "warning",
  under_review: "warning",
  completed: "success",
  rejected: "destructive",
  cancelled: "destructive",
};

const REWARD_VARIANT: Record<string, Variant> = {
  accrued: "info",
  scheduled: "warning",
  paid: "success",
  cancelled: "destructive",
};

export function AssignmentStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={ASSIGNMENT_VARIANT[status] ?? "secondary"}>
      {ASSIGNMENT_STATUS_LABELS[status as keyof typeof ASSIGNMENT_STATUS_LABELS] ?? status}
    </Badge>
  );
}

export function ContractStatusBadge({ status }: { status: string }) {
  return <Badge variant={CONTRACT_VARIANT[status] ?? "secondary"}>{CONTRACT_STATUS_LABELS[status] ?? status}</Badge>;
}

export function RewardStatusBadge({ status }: { status: string }) {
  return <Badge variant={REWARD_VARIANT[status] ?? "secondary"}>{REWARD_STATUS_LABELS[status] ?? status}</Badge>;
}
