import { isUuid } from "./form.ts";

const ACTIONS: Record<string, string> = {
  "settings.update": "運営ルールを変更",
  "session.created": "ログイン",
  "session.deleted": "ログアウト",
  "company.update_by_ops": "企業情報を更新",
  "company.profile_verified": "制作に使う会社情報を確認",
  "company.official_site_status": "公式サイトの確認状態を更新",
  "company.website_candidate_saved": "公式サイト候補と確認根拠を保存",
  "company.make_sellable": "営業への公開を開始",
  "company.withdraw_sellable": "営業への公開を取り下げ",
  "discovery.job_created": "企業収集を依頼",
  "discovery.job_started": "企業収集を開始",
  "discovery.job_succeeded": "企業収集が完了",
  "discovery.job_failed": "企業収集が停止",
  "discovery.job_retried": "企業収集を再試行",
  "discovery.company_created": "収集した企業を登録",
  "discovery.company_updated": "収集した企業を更新",
  "proposal_version.approve": "提案を承認",
  "proposal_version.reject": "提案の修正を依頼",
  "image_asset.create": "画像素材を登録",
  "image_asset.policy_update": "画像素材の利用許可を変更",
  "product_terms.create": "販売条件の版を作成",
  "product_terms.activate": "販売条件を有効化",
  "product_terms.deactivate": "販売条件を無効化",
  "worker.step_started": "処理工程を開始",
  "worker.step_succeeded": "処理工程が完了",
  "worker.step_failed": "処理工程が停止",
};
export const HISTORY_TARGETS: Record<string, string> = {
  company: "企業",
  discovery_job: "収集依頼",
  proposal_version: "提案の版",
  design_version: "デザインの版",
  assignment: "営業担当",
  contract: "契約",
  delivery: "納品",
  deployment: "公開先",
  settings: "運営ルール",
  user: "ユーザー",
  session: "ログイン状態",
  worker_step: "処理工程",
  audit_request: "診断依頼",
  product_terms: "販売条件",
  website_candidate_operation: "候補保存の受付",
};
const GROUPS: Record<string, string> = {
  company: "企業",
  discovery: "企業収集",
  proposal_version: "提案",
  design: "デザイン",
  assignment: "営業担当",
  contract: "契約",
  delivery: "納品",
  deployment: "公開",
  article: "記事",
  content: "記事",
  settings: "運営ルール",
  user: "ユーザー",
  auth: "ログイン",
  session: "ログイン",
  worker: "自動処理",
  backup: "バックアップ",
  publication_material: "公開素材",
  image_asset: "画像素材",
  consultation: "相談",
  reward: "報酬",
};
export function historyActionLabel(action: string) {
  const group = action.split(".")[0]!;
  return Object.hasOwn(ACTIONS, action)
    ? ACTIONS[action]!
    : Object.hasOwn(GROUPS, group)
      ? `${GROUPS[group]}の操作`
      : "記録された操作";
}
export function historyMatchingActions(query: string) {
  const q = query.toLowerCase();
  return Object.entries(ACTIONS)
    .filter(([, label]) => label.toLowerCase().includes(q))
    .map(([code]) => code);
}
export function historyTargetLink(type: string, id: string, name: string | null) {
  if (!isUuid(id)) return null;
  if (type === "company" && name) return `/ops/companies/${id}`;
  if (type === "discovery_job") return `/ops/discovery/${id}`;
  return null;
}
const secretKey = (key: string) =>
  /^(?:password(?:hash)?|passphrase|apikey|accesstoken|refreshtoken|idtoken|token|authorization|credentials|privatekey|clientsecret|session(?:id|token)?|transfercode|authfile|codexauthfile|sig|signature|xamzsignature|xamzsecuritytoken|xgoogsignature)$/i.test(
    key.replace(/[_\s-]/g, ""),
  );
const FIELDS: Record<string, string> = {
  status: "状態",
  officialSiteStatus: "公式サイトの確認状態",
  pipelineStatus: "案件の進行状態",
  name: "名称",
  url: "URL",
  sourceUrl: "出典URL",
  note: "メモ",
  reason: "理由",
  createdAt: "作成日時",
  updatedAt: "更新日時",
  expiresAt: "有効期限",
  websiteId: "サイトID",
  companyId: "企業ID",
  version: "版",
  versionId: "版ID",
  jobId: "処理ID",
  requestId: "受付ID",
  value: "設定値",
  key: "設定項目",
  before: "変更前",
  after: "変更後",
  amount: "金額",
  suppression: "営業抑止",
  actorId: "操作したユーザーID",
  found: "見つかった件数",
  created: "追加した件数",
  updated: "更新した件数",
  skipped: "見送った件数",
  failed: "失敗した件数",
  error: "エラー",
  limit: "件数上限",
};
const STATES: Record<string, string> = {
  queued: "開始待ち",
  running: "処理中",
  succeeded: "完了",
  failed: "失敗",
  confirmed: "確認済み",
  candidate: "候補あり",
  needs_review: "確認待ち",
  not_found: "見つかっていない",
  approved: "承認済み",
  rejected: "承認見送り",
  active: "有効",
  suspended: "利用停止",
};
const fieldValue = (key: string, value: unknown) =>
  typeof value === "string" &&
  ["status", "officialSiteStatus", "pipelineStatus"].includes(key) &&
  Object.hasOwn(STATES, value)
    ? `${STATES[value]}（${value}）`
    : historyValue(value);
/** Bounded, text-only view. It is not a raw audit export or a complete deep diff. */
export function historyValue(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (typeof value === "string") {
    if (/(?:sk-(?:proj-)?[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9_]{20,}|Bearer\s+\S+)/i.test(value))
      return "[認証情報を含むため非表示]";
    try {
      const url = new URL(value);
      if (
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((key) => secretKey(key) || key.toLowerCase() === "key")
      )
        return "[認証情報を含むURLのため非表示]";
    } catch {}
    return value.length > 2000 ? `${value.slice(0, 2000)}…（表示を省略）` : value;
  }
  if (typeof value !== "object") return value;
  if (depth >= 4) return "[深い階層の表示を省略]";
  if (Array.isArray(value))
    return [
      ...value.slice(0, 20).map((item) => historyValue(item, depth + 1)),
      ...(value.length > 20 ? [`ほか${value.length - 20}件の表示を省略`] : []),
    ];
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, 30))
    Object.defineProperty(out, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: secretKey(key) ? "[非表示]" : historyValue(item, depth + 1),
    });
  if (entries.length > 30)
    Object.defineProperty(out, "表示の省略", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: `ほか${entries.length - 30}項目`,
    });
  return out;
}
export function historyFields(before: unknown, after: unknown) {
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  if (before === null && after === null) return { omitted: 0, items: [] };
  const a = object(before) ? before : before === null && object(after) ? {} : { 記録: before },
    b = object(after) ? after : after === null && object(before) ? {} : { 記録: after };
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return {
    omitted: Math.max(0, keys.length - 30),
    items: keys.slice(0, 30).map((key) => ({
      key,
      label: Object.hasOwn(FIELDS, key) ? FIELDS[key]! : key,
      before: secretKey(key) ? "[非表示]" : Object.hasOwn(a, key) ? fieldValue(key, a[key]) : "（項目の記録なし）",
      after: secretKey(key) ? "[非表示]" : Object.hasOwn(b, key) ? fieldValue(key, b[key]) : "（項目の記録なし）",
    })),
  };
}
