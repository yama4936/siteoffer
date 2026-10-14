// 営業画面の表示用ラベル。状態の判定はしない（判定は core の業務関数）

import type { AssignmentStatus, DomainIntent, DomainManager, SalesActivityKind, TriState } from "@siteoffer/core";

/** 活動の種類（12.3の9種）。並びは要件の記載順 */
export const ACTIVITY_KINDS: readonly { value: SalesActivityKind; label: string }[] = [
  { value: "not_started", label: "未着手" },
  { value: "no_answer", label: "不在" },
  { value: "callback_scheduled", label: "再連絡予定" },
  { value: "proposal_sent", label: "提案送付" },
  { value: "negotiating", label: "商談中" },
  { value: "contract_review", label: "契約確認待ち" },
  { value: "contract_completed", label: "契約完了（申告）" },
  { value: "lost", label: "失注" },
  { value: "declined", label: "営業拒否" },
];

export function activityKindLabel(kind: string): string {
  return ACTIVITY_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

export const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  claimed: "確保済み（未着手）",
  working: "対応中",
  negotiating: "商談中",
  awaiting_ops: "運営確認待ち",
  contract_pending: "契約確認待ち",
  completed: "契約完了",
  released: "解除",
  lost: "失注・営業拒否",
};

export const SUPPRESSION_LABELS: Record<string, string> = {
  none: "なし",
  not_now: "営業拒否（今は不要）",
  do_not_contact: "営業拒否（今後連絡しないでほしい）",
  excluded: "運営により除外",
  existing_customer: "既存顧客",
};

export const CONTRACT_STATUS_LABELS: Record<string, string> = {
  reported: "成約報告済み（運営の確認待ち）",
  under_review: "運営が契約資料を確認中",
  completed: "契約完了",
  rejected: "差し戻し",
  cancelled: "取り消し",
};

export const REWARD_STATUS_LABELS: Record<string, string> = {
  accrued: "発生（支払日未定）",
  scheduled: "支払予定",
  paid: "支払済み",
  cancelled: "取り消し",
};

/** ドメインの希望（13章）。接続先の変更と移管は別の選択として説明する */
export const DOMAIN_INTENTS: readonly { value: DomainIntent; label: string; help: string }[] = [
  {
    value: "keep",
    label: "現在のドメインを使い続ける",
    help: "ドメインの管理会社は変えず、接続先（DNS）の変更だけで新しいサイトを表示する想定です。",
  },
  {
    value: "transfer_consult",
    label: "ドメインの移管を相談したい",
    help: "ドメインの管理会社（レジストラ）を変える手続きです。接続先の変更とは別の手続きです。",
  },
  { value: "new", label: "新しいドメインを取得したい", help: "希望の候補を記録します。" },
  { value: "undecided", label: "未定", help: "" },
];

export const DOMAIN_MANAGERS: readonly { value: DomainManager; label: string }[] = [
  { value: "company", label: "企業自身" },
  { value: "vendor", label: "制作会社など" },
  { value: "unknown", label: "不明" },
];

export const TRI_STATES: readonly { value: TriState; label: string }[] = [
  { value: "yes", label: "使っている" },
  { value: "no", label: "使っていない" },
  { value: "unknown", label: "不明" },
];

export function labelOf<T extends string>(list: readonly { value: T; label: string }[], value: string): string {
  return list.find((x) => x.value === value)?.label ?? value;
}

/** 診断の評価カテゴリ（site-evaluation のA〜G）。名前が分からないものは記号のまま出す */
export const FINDING_STATUS_LABELS: Record<string, string> = {
  scored: "評価済み",
  unevaluable: "評価できず",
  not_applicable: "対象外",
};

const dateFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 日時の表示（日本時間） */
export function formatDateTime(d: Date | null | undefined): string {
  return d ? dateFmt.format(d) : "—";
}

export function formatDate(d: Date | null | undefined): string {
  return d ? dayFmt.format(d) : "—";
}

export function formatYen(n: number | null | undefined): string {
  return n === null || n === undefined ? "未設定" : `${n.toLocaleString("ja-JP")}円`;
}
