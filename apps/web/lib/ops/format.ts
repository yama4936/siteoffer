/** 運営画面の表示用の文言と整形。サーバー・クライアントどちらからも使える純粋関数だけを置く */

export const PIPELINE_LABEL: Record<string, string> = {
  collected: "収集済み",
  site_confirmed: "公式サイト確認済み",
  audited: "診断済み",
  generated: "生成済み",
  in_review: "運営確認中",
  sellable: "営業可能",
  on_hold: "保留",
  failed: "失敗",
};

export const OFFICIAL_SITE_LABEL: Record<string, string> = {
  confirmed: "確認済み",
  candidate: "候補",
  needs_review: "確認待ち",
  not_found: "不明",
};

export const SUPPRESSION_LABEL: Record<string, string> = {
  none: "なし",
  not_now: "今は不要",
  do_not_contact: "今後連絡しないで",
  excluded: "対象外（除外）",
  existing_customer: "既存顧客",
};

export const JOB_STATUS_LABEL: Record<string, string> = {
  queued: "待機",
  running: "実行中",
  succeeded: "成功",
  failed: "失敗",
  needs_review: "確認待ち",
  cancelled: "取消",
};

export const PROPOSAL_STATUS_LABEL: Record<string, string> = {
  generating: "生成中",
  in_review: "運営確認待ち",
  approved: "承認済み",
  rejected: "差し戻し",
  failed: "失敗",
};

export const ASSIGNMENT_STATUS_LABEL: Record<string, string> = {
  claimed: "確保（未着手）",
  working: "営業中",
  negotiating: "商談中",
  awaiting_ops: "運営確認待ち",
  contract_pending: "契約確認待ち",
  completed: "契約完了",
  released: "解除",
  lost: "失注",
};

export const ACTIVITY_LABEL: Record<string, string> = {
  not_started: "未着手",
  no_answer: "不在",
  callback_scheduled: "再連絡予定",
  proposal_sent: "提案送付",
  negotiating: "商談中",
  contract_review: "契約確認待ち",
  contract_completed: "契約完了",
  lost: "失注",
  declined: "営業拒否",
};

export const CONTRACT_STATUS_LABEL: Record<string, string> = {
  reported: "成約報告（未確認）",
  under_review: "確認中",
  completed: "契約完了",
  rejected: "差し戻し",
  cancelled: "取消",
};

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending: "入金待ち",
  received: "入金済み",
  refunded: "返金",
  cancelled: "取消",
};

export const REWARD_STATUS_LABEL: Record<string, string> = {
  accrued: "発生",
  scheduled: "支払予定",
  paid: "支払済み",
  cancelled: "取消",
};

export const DOMAIN_INTENT_LABEL: Record<string, string> = {
  keep: "現在のドメインを継続",
  transfer_consult: "移管の相談",
  new: "新規取得",
  undecided: "未定",
};

export const DOMAIN_MANAGER_LABEL: Record<string, string> = {
  company: "企業",
  vendor: "制作会社",
  unknown: "不明",
};

export const TRI_LABEL: Record<string, string> = { yes: "あり", no: "なし", unknown: "不明" };

export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  info_gathering: "情報確認",
  building: "制作",
  ops_review: "運営確認",
  customer_review: "顧客確認",
  ready: "公開準備",
  published: "公開",
  delivered: "納品",
};

export function label(map: Record<string, string>, key: string | null | undefined): string {
  if (key === null || key === undefined) return "—";
  return map[key] ?? key;
}

const dtf = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** 日時は日本時間で表示する。null は「—」 */
export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "—" : dtf.format(date);
}

export function yen(n: number | null | undefined): string {
  return n === null || n === undefined ? "未設定" : `${n.toLocaleString("ja-JP")}円`;
}

/** 報酬条件（product_terms.reward_rule）の表示 */
export function rewardRuleText(rule: unknown): string {
  if (!rule || typeof rule !== "object") return "未設定";
  const r = rule as { type?: string; amount?: number; basisPoints?: number };
  if (r.type === "fixed" && typeof r.amount === "number") return `定額 ${yen(r.amount)}`;
  if (r.type === "rate" && typeof r.basisPoints === "number") return `販売価格の ${(r.basisPoints / 100).toFixed(2)}%`;
  return "不正な値";
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
