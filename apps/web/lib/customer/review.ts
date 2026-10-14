/**
 * 顧客確認の画面のサーバー処理（共有リンクのトークン → core の関数 → 画面用の値）。
 * 顧客は常設ログインを持たない（5.3）。アプリのセッションCookieは読まず、トークンだけで判定する。
 * 判定（期限・取り消し・版の一致・受付中か）は core の関数が行う。
 * Next.js に依存しない形にして、PGlite の結合テストから直接呼べるようにしている。
 */
import { type Clock, isShareTokenFormat, shareLinkUrl } from "@siteoffer/core";
import type { DbOrTx } from "@siteoffer/db";
import { previewOrigin } from "../sales/preview.ts";
import {
  CUSTOMER_COMMENT_MAX,
  type CustomerDecision,
  type CustomerReview,
  decideAsCustomer,
  getCustomerReview,
} from "./core.ts";

export interface CustomerDeps {
  db: DbOrTx;
  clock: Clock;
}

/** 顧客のフォーム処理の結果（クライアントのフォームとサーバー処理の両方で使う） */
export type CustomerActionState = { status: "ok" | "error"; message: string } | undefined;

export interface CustomerReviewView extends CustomerReview {
  /** 制作版のプレビュー（apps/preview の別オリジン） */
  previewUrl: string;
}

export const INVALID_LINK_MESSAGE =
  "このリンクは無効か、有効期限が切れています。お手数ですが、ご案内をお送りした担当窓口までお問い合わせください。";

/** 画面の表示用。無効なリンクは理由を区別せず null（存在を明かさない） */
export async function loadCustomerReview(
  deps: CustomerDeps,
  token: string,
  origin: string = previewOrigin(),
): Promise<CustomerReviewView | null> {
  if (!isShareTokenFormat(token)) return null;
  const r = await getCustomerReview(deps.db, deps.clock, token);
  if (!r.ok) return null;
  return { ...r.value, previewUrl: shareLinkUrl(origin, token) };
}

const str = (fd: FormData, key: string): string => {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUCCESS: Record<CustomerDecision, string> = {
  approved:
    "ご確認ありがとうございます。この版での承認を受け付けました。公開に向けた準備を進め、日程が決まりましたら担当窓口からご連絡します。",
  changes_requested: "修正のご依頼を受け付けました。内容を確認のうえ修正版をご用意し、あらためてご確認をお願いします。",
};

const fail = (message: string): CustomerActionState => ({ status: "error", message });

/**
 * 承認・修正依頼のフォーム。項目：token、versionId、decision（approved / changes_requested）、
 * comment（修正依頼では必須）、confirmed（承認では内容確認のチェックが必須）。
 */
export async function submitCustomerDecision(deps: CustomerDeps, fd: FormData): Promise<CustomerActionState> {
  const token = str(fd, "token");
  const versionId = str(fd, "versionId");
  if (!isShareTokenFormat(token) || !UUID_RE.test(versionId)) return fail(INVALID_LINK_MESSAGE);
  const decision = str(fd, "decision");
  if (decision !== "approved" && decision !== "changes_requested") {
    return fail("「承認する」か「修正を依頼する」を選んでください。");
  }
  const comment = str(fd, "comment");
  if (comment.length > CUSTOMER_COMMENT_MAX)
    return fail(`コメントは${CUSTOMER_COMMENT_MAX}文字以内で入力してください。`);
  if (decision === "changes_requested" && !comment) return fail("修正してほしい点をご記入ください。");
  if (decision === "approved" && fd.get("confirmed") !== "on") {
    return fail("掲載内容（会社名・連絡先・サービス内容など）をご確認のうえ、確認のチェックを入れてください。");
  }

  const r = await decideAsCustomer(deps.db, deps.clock, token, { versionId, decision, comment });
  if (r.ok) return { status: "ok", message: SUCCESS[decision] };
  switch (r.error) {
    case "link_invalid":
      return fail(INVALID_LINK_MESSAGE);
    case "not_under_review":
      return fail("この版は現在、確認の受付を行っていません。最新のご案内をご確認ください。");
    case "invalid_input":
      return fail(r.message ? `${r.message}。` : "入力内容をご確認ください。");
  }
}

/** 日時を日本時間で表示する */
export function formatJst(d: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
