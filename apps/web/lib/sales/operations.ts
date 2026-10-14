/**
 * 営業画面のサーバー処理（フォームの値の読み取り → core の業務関数 → 画面用の結果）。
 * 権限・業務条件の判定は core の業務関数が行う。ここでは判定しない（AC-17）。
 * Next.js に依存しない形にして、PGlite の結合テストから直接呼べるようにしている。
 * Server Action（app/(sales)/actions.ts）は、ログイン中の actor・DB・時計を渡してこれを呼ぶ。
 */
import {
  type Actor,
  type Clock,
  claimAssignment,
  type DeclineKind,
  type DomainIntent,
  type DomainManager,
  recordActivity,
  releaseAssignment,
  reportContract,
  type SalesActivityKind,
  saveDomainPreference,
  type TriState,
} from "@siteoffer/core";
import type { DbOrTx } from "@siteoffer/db";
import type { SalesActionState } from "./action-state.ts";
import { ACTIVITY_KINDS, DOMAIN_INTENTS, DOMAIN_MANAGERS, TRI_STATES } from "./labels.ts";
import { UUID_RE } from "./queries.ts";

export interface SalesDeps {
  db: DbOrTx;
  clock: Clock;
  actor: Actor | null;
}

const str = (fd: FormData, key: string): string => {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
};
/** IDの欄。形式違いは空として扱う（DBに渡さない） */
const id = (fd: FormData, key: string): string => {
  const v = str(fd, key);
  return UUID_RE.test(v) ? v : "";
};
const optStr = (fd: FormData, key: string): string | undefined => str(fd, key) || undefined;

const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 入力欄の日時（datetime-local / date）を日本時間として読む。空なら undefined、形式違いは null。
 * サーバーのタイムゾーン設定に左右されないよう、+09:00 を付けて解釈する。
 */
export function parseJstDateTime(raw: string): Date | undefined | null {
  if (!raw) return undefined;
  let iso: string;
  if (DATETIME_LOCAL.test(raw)) iso = `${raw}:00+09:00`;
  else if (DATE_ONLY.test(raw)) iso = `${raw}T00:00:00+09:00`;
  else return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const fail = (message: string): SalesActionState => ({ status: "error", message });

/** core のエラーコードを画面の文言にする。業務関数のメッセージがあればそれを優先する */
const MESSAGES: Record<string, string> = {
  forbidden: "この操作は行えません。",
  unauthenticated: "ログインしてください。",
  not_found: "対象が見つかりません。",
  assignment_not_found: "担当が見つかりません。",
  company_not_found: "企業が見つかりません。",
  company_not_sellable: "この企業は現在、営業候補として公開されていません。",
  company_suppressed: "この企業は営業拒否などにより、現在は担当を確保できません。",
  already_assigned: "この企業は他の営業ユーザーが担当中です。",
  limit_reached: "同時に担当できる件数の上限に達しています。不要な担当を手放してから確保してください。",
  user_not_found: "ユーザーが見つかりません。",
  user_not_sales: "営業ユーザーだけが担当を確保できます。",
  user_suspended: "利用停止中のため操作できません。",
  not_active: "この担当はすでに終了しています。",
  invalid_input: "入力内容を確認してください。",
  stronger_suppression_exists: "この企業にはより強い営業抑止が記録済みです。",
  already_reported: "この担当はすでに成約報告済みです。",
  invalid_state: "現在の状態ではこの操作は行えません。",
  secret_like_value:
    "パスワード・移管コード・鍵などの秘密情報らしき値が含まれているため保存しませんでした。秘密情報は入力しないでください。",
  terms_not_found: "販売条件が見つかりません。",
  terms_not_ready: "販売条件・報酬条件が未設定です。",
};

function errorState(r: { error: string; message?: string }): SalesActionState {
  // invalid_input の message は項目名のことがあるため、項目名だけなら定型文を添える。
  // 権限判定の定型メッセージ（例：assignment.update は許可されていません）は内部の識別子なので出さない
  const base = MESSAGES[r.error] ?? "処理できませんでした。";
  if (r.message && /^\w+\.\w+ は許可されていません$/.test(r.message)) return fail(base);
  if (r.message && /[^\x20-\x7e]/.test(r.message)) return fail(r.message);
  return fail(r.message ? `${base}（${r.message}）` : base);
}

// ---------- 担当確保 ----------

export async function claimCompany(deps: SalesDeps, fd: FormData): Promise<SalesActionState> {
  const companyId = id(fd, "companyId");
  if (!companyId) return fail("企業が指定されていません。");
  if (!deps.actor) return fail(MESSAGES.unauthenticated!);
  const r = await claimAssignment(deps.db, deps.clock, deps.actor, companyId);
  if (!r.ok) return errorState(r);
  return { status: "ok", message: "担当を確保しました。", assignmentId: r.value.id };
}

// ---------- 担当を手放す ----------

export async function releaseMyAssignment(deps: SalesDeps, fd: FormData): Promise<SalesActionState> {
  const assignmentId = id(fd, "assignmentId");
  const reason = str(fd, "reason") || "営業ユーザーが手放した";
  if (!assignmentId) return fail("担当が指定されていません。");
  if (!deps.actor) return fail(MESSAGES.unauthenticated!);
  const r = await releaseAssignment(deps.db, deps.clock, deps.actor, { assignmentId, reason });
  if (!r.ok) return errorState(r);
  return { status: "ok", message: "担当を手放しました。" };
}

// ---------- 活動記録 ----------

const KIND_VALUES = new Set<string>(ACTIVITY_KINDS.map((k) => k.value));

export async function recordSalesActivity(deps: SalesDeps, fd: FormData): Promise<SalesActionState> {
  const assignmentId = id(fd, "assignmentId");
  const kind = str(fd, "kind");
  if (!assignmentId) return fail("担当が指定されていません。");
  if (!KIND_VALUES.has(kind)) return fail("活動の種類を選んでください。");
  const occurredAt = parseJstDateTime(str(fd, "occurredAt"));
  const nextActionAt = parseJstDateTime(str(fd, "nextActionAt"));
  if (occurredAt === null) return fail("活動日時の形式が正しくありません。");
  if (nextActionAt === null) return fail("次回対応日の形式が正しくありません。");

  let decline: { kind: DeclineKind; recontactAfter?: Date; reason?: string } | undefined;
  if (kind === "declined") {
    const declineKind = str(fd, "declineKind");
    if (declineKind !== "not_now" && declineKind !== "do_not_contact") {
      return fail("営業拒否の内容（今は不要／今後連絡しないでほしい）を選んでください。");
    }
    const recontactAfter = parseJstDateTime(str(fd, "recontactAfter"));
    if (recontactAfter === null) return fail("再連絡の目安の形式が正しくありません。");
    decline = { kind: declineKind };
    if (declineKind === "not_now" && recontactAfter) decline.recontactAfter = recontactAfter;
    const reason = optStr(fd, "declineReason");
    if (reason) decline.reason = reason;
  }

  if (!deps.actor) return fail(MESSAGES.unauthenticated!);
  const note = optStr(fd, "note");
  const r = await recordActivity(deps.db, deps.clock, deps.actor, {
    assignmentId,
    kind: kind as SalesActivityKind,
    ...(occurredAt ? { occurredAt } : {}),
    ...(note ? { note } : {}),
    ...(nextActionAt ? { nextActionAt } : {}),
    consultOps: fd.get("consultOps") === "on",
    ...(decline ? { decline } : {}),
  });
  if (!r.ok) return errorState(r);
  return { status: "ok", message: "活動を記録しました。" };
}

// ---------- ドメイン希望 ----------

const INTENT_VALUES = new Set<string>(DOMAIN_INTENTS.map((x) => x.value));
const MANAGER_VALUES = new Set<string>(DOMAIN_MANAGERS.map((x) => x.value));
const TRI_VALUES = new Set<string>(TRI_STATES.map((x) => x.value));

/**
 * ドメイン希望の記録（13章）。レジストラのパスワード・移管コード・鍵は受け付けない
 * （入力欄を作らず、自由記述に含まれていれば core が保存を拒否する）。
 */
export async function saveDomainWish(deps: SalesDeps, fd: FormData): Promise<SalesActionState> {
  const assignmentId = id(fd, "assignmentId");
  const companyId = id(fd, "companyId");
  const intent = str(fd, "intent");
  if (!assignmentId || !companyId) return fail("担当が指定されていません。");
  if (!INTENT_VALUES.has(intent)) return fail("ドメインの希望を選んでください。");
  const manager = str(fd, "currentManager") || "unknown";
  const usesEmail = str(fd, "usesEmail") || "unknown";
  if (!MANAGER_VALUES.has(manager) || !TRI_VALUES.has(usesEmail)) return fail("選択肢を確認してください。");
  const candidates = str(fd, "newDomainCandidates")
    .split(/[\s,、]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (!deps.actor) return fail(MESSAGES.unauthenticated!);
  const r = await saveDomainPreference(deps.db, deps.clock, deps.actor, {
    companyId,
    assignmentId,
    currentUrl: optStr(fd, "currentUrl") ?? null,
    currentDomain: optStr(fd, "currentDomain") ?? null,
    intent: intent as DomainIntent,
    newDomainCandidates: candidates,
    currentManager: manager as DomainManager,
    usesEmail: usesEmail as TriState,
    customerWish: optStr(fd, "customerWish") ?? null,
  });
  if (!r.ok) {
    if (r.error === "invalid_input" && r.message === "newDomainCandidates")
      return fail("新規ドメイン候補の形式を確認してください（例：example.jp、10件まで）。");
    if (r.error === "invalid_input" && r.message === "currentDomain")
      return fail("現在のドメインの形式を確認してください（例：example.co.jp）。");
    return errorState(r);
  }
  return { status: "ok", message: "ドメイン希望を記録しました。運営が内容を確認します。", notices: r.value.notices };
}

// ---------- 成約報告 ----------

/** 成約報告。報告だけでは報酬は確定しない（運営が契約資料を確認して契約完了にする、14章） */
export async function reportDeal(deps: SalesDeps, fd: FormData): Promise<SalesActionState> {
  const assignmentId = id(fd, "assignmentId");
  if (!assignmentId) return fail("担当が指定されていません。");
  if (!deps.actor) return fail(MESSAGES.unauthenticated!);
  const r = await reportContract(deps.db, deps.clock, deps.actor, {
    assignmentId,
    productTermsId: id(fd, "productTermsId") || null,
    proposalVersionId: id(fd, "proposalVersionId") || null,
    documentRef: optStr(fd, "documentRef") ?? null,
    reportNote: optStr(fd, "reportNote") ?? null,
  });
  if (!r.ok) return errorState(r);
  return {
    status: "ok",
    message: "成約報告を受け付けました。運営が契約資料を確認し、確認できた時点で契約完了になります。",
  };
}
