export interface AuditStepResult {
  companyId: string;
  /** 診断しなかった理由（営業抑止・公式サイト未確認） */
  skipped: string | null;
  auditId: string | null;
  auditStatus: "evaluated" | "unevaluable" | null;
  decision: "create" | "skip" | "hold" | null;
  /** 生成依頼を永続化した（キュー停止時は自動再送する） */
  proposalQueued: boolean;
}
