import { createHash, createHmac, randomBytes } from "node:crypto";

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

/** サーバー専用の鍵から再現可能なトークンを作る。鍵・トークンはDBやログに保存しない。 */
export interface ShareTokenRecovery {
  keyId: string;
  derive: (id: string, userId: string, purpose: string, targetId: string) => string;
}
export function createShareTokenRecovery(secret: string): ShareTokenRecovery {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || Buffer.from(secret, "base64url").toString("base64url") !== secret)
    throw new Error("共有リンク復旧用の鍵は32バイトのbase64urlで設定してください");
  const key = Buffer.from(secret, "base64url");
  return {
    keyId: createHash("sha256").update(key).digest("hex"),
    derive: (id, userId, purpose, targetId) =>
      createHmac("sha256", key)
        .update(JSON.stringify(["siteoffer-share-v1", id, userId, purpose, targetId]))
        .digest("base64url"),
  };
}
