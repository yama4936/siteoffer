import type { loadCompanyContentAccess } from "@siteoffer/core";

export type CompanyTeam = Awaited<ReturnType<typeof loadCompanyContentAccess>>;
export type CompanyTeamRow = CompanyTeam["access"][number];
export type CompanyTeamRowView = {
  self: boolean;
  roleLabel: string;
  statusLabel: string;
  /** 管理者の行に出す案内（管理者の変更は運営が行う） */
  note: string | null;
  /** 解除・取り消しのボタン文言。出さない行は null */
  revokeLabel: string | null;
  /** 解除済み・期限切れの編集者は、入力欄に入れて再招待できる */
  canReinvite: boolean;
};

/** 担当者の一覧の1行の表示。解除できるのは自分以外の、解除されていない編集者だけ（判定は core でも行う） */
export function companyTeamRowView(row: CompanyTeamRow, selfAccessId: string, now = Date.now()): CompanyTeamRowView {
  const self = row.id === selfAccessId,
    expired = row.status === "invited" && Date.parse(row.expiresAt) <= now;
  const statusLabel =
    row.status === "revoked"
      ? "解除済み"
      : row.status === "invited"
        ? expired
          ? "招待の期限が切れました"
          : "招待中（まだ利用を始めていません）"
        : row.accountStatus === "suspended"
          ? "アカウント停止中"
          : "利用中";
  const editor = row.role === "editor";
  return {
    self,
    roleLabel: row.role === "admin" ? "管理者" : "編集者",
    statusLabel,
    note: row.role === "admin" ? "管理者の変更は運営にご依頼ください" : null,
    revokeLabel:
      !self && editor && row.status !== "revoked" ? (row.status === "active" ? "解除する" : "招待を取り消す") : null,
    canReinvite: !self && editor && (row.status === "revoked" || expired),
  };
}
