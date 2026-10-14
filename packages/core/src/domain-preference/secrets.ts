/**
 * 営業メモ等の自由記述に、秘密らしき値（移管コード・パスワード・AWSキー・秘密鍵）が
 * 混ざっていないかを調べる（13章）。見つけた値そのものは返さず、種類だけを返す。
 *
 * 誤検出を完全には避けられないため、検出時は保存を拒否し、入力し直してもらう前提。
 */
export type SecretKind = "aws_access_key" | "aws_secret_key" | "private_key" | "password" | "transfer_code";

const KEYWORD_VALUE: Array<{ kind: SecretKind; re: RegExp }> = [
  // 「パスワード: xxx」「password=xxx」「PW は xxx」など、キーワードの直後に英数記号の値がある。
  // 「パスワードは企業が管理」のような日本語の説明は対象外にする
  {
    kind: "password",
    re: /(password|passwd|pass\s*word|pwd|\bpw\b|パスワード|パス|暗証番号)\s*(?:[:：=＝]|は|が)\s*[\x21-\x7e]{4,}/i,
  },
  // 「移管コード: xxx」「AuthCode xxx」「EPPコード」など
  {
    kind: "transfer_code",
    re: /(移管コード|認証コード|auth\s*-?\s*code|auth\s*-?\s*info|\bepp\s*(?:code|コード|key)?)\s*(?:[:：=＝]|は|が)?\s*[\x21-\x7e]{6,}/i,
  },
  { kind: "aws_secret_key", re: /aws_secret_access_key|secret\s*access\s*key|シークレット(?:アクセス)?キー/i },
];

const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** AWSのシークレットキーに似た40文字の英数字（/・+を含みうる） */
const AWS_SECRET_LIKE = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;

const URL_OR_DOMAIN = /^(https?:\/\/\S+|[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?|[^@\s]+@[^@\s]+)$/i;

function hasMixedClasses(s: string): boolean {
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
}

/**
 * 移管コード・パスワード風の単独の文字列。
 * - 大文字・小文字・数字・記号（- . _ / : 以外）をすべて含む8文字以上
 * - または記号なしで大文字・小文字・数字を含む16文字以上（ランダムな鍵）
 * URL・ドメイン・メールアドレスの形のものは除く。
 */
function looksLikeRandomToken(token: string): boolean {
  if (token.length < 8 || token.length > 128) return false;
  if (URL_OR_DOMAIN.test(token)) return false;
  if (!hasMixedClasses(token)) return false;
  if (/[!@#$%^&*()+=[\]{};'"<>?\\|`~,]/.test(token)) return true;
  return token.length >= 16 && /^[A-Za-z0-9]+$/.test(token);
}

export function detectSecretLike(text: string | null | undefined): SecretKind | null {
  if (!text) return null;
  if (PRIVATE_KEY.test(text)) return "private_key";
  if (AWS_ACCESS_KEY.test(text)) return "aws_access_key";
  for (const { kind, re } of KEYWORD_VALUE) {
    if (re.test(text)) return kind;
  }
  for (const m of text.matchAll(AWS_SECRET_LIKE)) {
    if (hasMixedClasses(m[0])) return "aws_secret_key";
  }
  for (const token of text.split(/[\s、。，,（）()「」]+/)) {
    if (looksLikeRandomToken(token)) return "transfer_code";
  }
  return null;
}

/** 複数の欄をまとめて調べ、最初に見つかった欄名と種類を返す */
export function findSecretInFields(
  fields: Record<string, string | readonly string[] | null | undefined>,
): { field: string; kind: SecretKind } | null {
  for (const [field, value] of Object.entries(fields)) {
    const values = Array.isArray(value) ? value : [value as string | null | undefined];
    for (const v of values) {
      const kind = detectSecretLike(v);
      if (kind) return { field, kind };
    }
  }
  return null;
}
