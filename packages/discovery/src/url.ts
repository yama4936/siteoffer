import { err, ok, type Result } from "@siteoffer/core";

/** 追跡用パラメータ。正規化で取り除く */
const TRACKING_PARAMS = new Set([
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "yclid",
  "msclkid",
  "twclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref",
  "ref_src",
]);

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith("utm_") || TRACKING_PARAMS.has(k);
}

export type UrlError = "invalid_url" | "unsupported_scheme" | "non_public_host";

export interface NormalizedUrl {
  /** 重複排除のキー。https に統一し、www・末尾スラッシュ・追跡用パラメータ・フラグメントを除く */
  normalizedUrl: string;
  /** www を除いた小文字のホスト名 */
  domain: string;
}

/**
 * 公開アドレスでないホスト（19章：内部ネットワーク・クラウドメタデータへのアクセスを防ぐ）。
 * 名前解決後のアドレス確認は取得処理（診断側）で行う。ここでは表記で判別できるものだけ弾く。
 */
function isNonPublicHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (!host.includes(".")) return true;
  if (host.startsWith("[")) return true; // IPv6リテラルは公式サイトのURLとして扱わない
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return true; // IPアドレス直書きは公式サイトのURLとして扱わない
  return false;
}

/**
 * URLを正規化する。
 * - スキーム：http/https のみ受け付け、https に統一する
 * - ホスト：小文字化し、先頭の www. と既定ポートを除く
 * - パス：末尾スラッシュを除く（ルートは空）。大文字小文字はサーバーが区別しうるので保つ
 * - クエリ：追跡用パラメータを除き、残りをキー順に並べる
 * - フラグメントは除く
 */
export function normalizeUrl(input: string): Result<NormalizedUrl, UrlError> {
  let raw = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err("invalid_url", `URLとして解釈できない：${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return err("unsupported_scheme", `http/https 以外のスキーム：${url.protocol}`);
  }
  if (url.username || url.password) return err("invalid_url", "認証情報を含むURLは扱わない");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isNonPublicHost(host)) return err("non_public_host", `公開アドレスでないホスト：${host}`);
  const domain = host.replace(/^www\./, "");
  const port = url.port && url.port !== "80" && url.port !== "443" ? `:${url.port}` : "";

  let path = url.pathname.replace(/\/+$/, "");
  if (path === "/") path = "";

  const params = [...url.searchParams.entries()]
    .filter(([k]) => !isTrackingParam(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";

  return ok({ normalizedUrl: `https://${domain}${port}${path}${query}`, domain });
}
