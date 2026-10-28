// 営業画面の企業詳細で、顧客の管理画面のアカウントと役割を表示するための整形（表示だけ・T23の(d)）
export type SalesCustomerAccount = {
  id: string;
  email: string;
  role: "admin" | "editor";
  status: "invited" | "active" | "revoked";
  accountStatus: "active" | "suspended" | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};
export type CustomerAccountState = "invited" | "expired" | "active" | "stopped";
export const CUSTOMER_ROLE_LABELS = { admin: "管理者", editor: "編集者" } as const;
export const CUSTOMER_ROLE_DESCRIPTIONS = {
  admin: "記事の編集と、自社の担当者の招待・解除ができます",
  editor: "記事の編集だけができます",
} as const;
export const CUSTOMER_STATE_LABELS: Record<CustomerAccountState, string> = {
  invited: "招待中",
  expired: "招待中（案内の期限切れ）",
  active: "利用中",
  stopped: "停止",
};
/** 解除済み・アカウント停止は「停止」。招待は期限ちょうどで期限切れとし、不正な期限は期限切れ扱いにする */
export function customerAccountState(row: SalesCustomerAccount, now: number): CustomerAccountState {
  if (row.status === "revoked" || row.accountStatus === "suspended") return "stopped";
  if (row.status === "active") return "active";
  const expires = Date.parse(row.expiresAt);
  return Number.isFinite(expires) && expires > now ? "invited" : "expired";
}
/** 表示順：管理者→編集者、同じ役割の中では利用中→招待中→期限切れ→停止（元の順を保つ） */
export function customerAccountRows(rows: SalesCustomerAccount[], now: number) {
  const stateOrder: CustomerAccountState[] = ["active", "invited", "expired", "stopped"];
  return rows
    .map((row, index) => ({ row, index, state: customerAccountState(row, now) }))
    .sort(
      (a, b) =>
        Number(a.row.role !== "admin") - Number(b.row.role !== "admin") ||
        stateOrder.indexOf(a.state) - stateOrder.indexOf(b.state) ||
        a.index - b.index,
    )
    .map(({ row, state }) => ({
      id: row.id,
      email: row.email,
      role: CUSTOMER_ROLE_LABELS[row.role] ?? "不明",
      state: CUSTOMER_STATE_LABELS[state],
      stopped: state === "stopped",
    }));
}
