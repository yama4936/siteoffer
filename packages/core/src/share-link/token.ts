import { createHash, randomBytes } from "node:crypto";

/** トークンの乱数のバイト数（256ビット） */
const TOKEN_BYTES = 32;

/** base64url（パディングなし）で 32 バイト = 43 文字 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 共有リンクのトークン（平文）を作る。平文は発行時に一度だけ返し、DBには hashShareToken の値だけを保存する */
export function generateShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** トークンの形式だけを確かめる（DBを引く前に、明らかに不正な値を落とす） */
export function isShareTokenFormat(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** DBに保存・照合するトークンのハッシュ（SHA-256 の16進）。トークンは十分な乱数なので塩は使わない */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * プレビュー配信（apps/preview）でのURL。baseUrl はプレビューのオリジン（例：http://localhost:3200）。
 * 相対リンクが正しく解決されるよう、末尾は必ず `/` にする。
 */
export function shareLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/s/${token}/`;
}
