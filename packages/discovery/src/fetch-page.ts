import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { err, ok, type Result } from "@siteoffer/core";
import { normalizeUrl } from "./url.ts";

/**
 * 公式サイトの実取得（agent-web の実在確認に使う）。19章のSSRF対策として、公開アドレスのHTTP(S)だけを取得する。
 * - URLの字面：http/https・認証情報なし・標準ポート・内部向けホスト名やIP直書きでない（normalizeUrl と同じ判定）
 * - 名前解決：接続時の lookup で解決したアドレスをすべて検査し、非公開アドレスが1つでもあれば接続しない
 *   （検査したアドレスにそのまま接続するので、確認後に解決結果を変える攻撃を受けない）
 * - リダイレクト：自動では追わず、1回ごとに上の検査をやり直す。回数に上限を置く
 * - 制限時間（全体）と本文サイズの上限。HTML・テキスト以外は読まない
 */

export type PageFetchError =
  | "blocked_url"
  | "blocked_address"
  | "too_many_redirects"
  | "http_status"
  | "unsupported_content_type"
  | "too_large"
  | "timeout"
  | "network_error";

export interface FetchedPage {
  /** リダイレクトを追った後のURL */
  finalUrl: string;
  status: number;
  contentType: string | null;
  body: string;
}

export type PageFetcher = (
  url: string,
  options?: { signal?: AbortSignal },
) => Promise<Result<FetchedPage, PageFetchError>>;

/** 1回のHTTPリクエスト（リダイレクトを追わない）。テストでは差し替える */
export type HttpTransport = (
  url: URL,
  options: { signal: AbortSignal; maxBytes: number; lookup: LookupFunction; userAgent: string },
) => Promise<
  Result<{ status: number; location: string | null; contentType: string | null; body: Buffer }, PageFetchError>
>;

export interface PublicPageFetcherOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** 名前解決。既定は node:dns の lookup（all: true） */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  transport?: HttpTransport;
}

function v4Parts(ip: string): number[] {
  return ip.split(".").map(Number);
}

/** 公開アドレス（グローバルユニキャスト）か。非公開・予約・ループバック・リンクローカル・マルチキャスト等は false */
export function isPublicIpAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0, c = 0] = v4Parts(ip);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // リンクローカル・クラウドメタデータ
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a >= 224) return false; // マルチキャスト・予約・ブロードキャスト
    return true;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return false;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIpAddress(mapped[1]!);
    if (s.startsWith("::ffff:") || s.startsWith("64:ff9b:") || s.startsWith("2001:db8:")) return false;
    if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff")) return false;
    // 2000::/3 以外（未割り当て・IPv4互換等）は扱わない
    return /^[23]/.test(s);
  }
  return false;
}

/** 取得してよいURLか（字面の検査）。名前解決後の検査は lookup で行う */
export function checkFetchableUrl(raw: string): Result<URL, "blocked_url"> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err("blocked_url", "URLとして解釈できない");
  }
  if (url.port && !["80", "443"].includes(url.port)) return err("blocked_url", `標準以外のポート（${url.port}）`);
  const n = normalizeUrl(url.href);
  if (!n.ok) return err("blocked_url", n.message ?? n.error);
  return ok(url);
}

function defaultResolve(host: string): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true }, (e, addresses) => (e ? reject(e) : resolve(addresses)));
  });
}

class BlockedAddressError extends Error {}

/** 解決したアドレスがすべて公開アドレスのときだけ接続させる lookup */
export function createPublicLookup(resolve = defaultResolve): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) return callback(new Error("名前解決の結果がない"));
        if (addresses.some((a) => !isPublicIpAddress(a.address))) {
          return callback(new BlockedAddressError("公開アドレスでないアドレスに解決された"));
        }
        if (options?.all) return callback(null, addresses);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (e: unknown) => callback(e),
    );
  }) as LookupFunction;
}

/** node:http(s) による1回分のリクエスト。本文は上限を超えた時点で打ち切る */
export const nodeHttpTransport: HttpTransport = (url, { signal, maxBytes, lookup, userAgent }) =>
  new Promise((resolve) => {
    const mod = url.protocol === "https:" ? https : http;
    let settled = false;
    const done = (r: Awaited<ReturnType<HttpTransport>>) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup,
        signal,
        headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        const contentType = typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null;
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return done(err("too_large", `本文が上限（${maxBytes}バイト）を超える`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            done(err("too_large", `本文が上限（${maxBytes}バイト）を超える`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => done(ok({ status, location, contentType, body: Buffer.concat(chunks) })));
        res.on("error", () => done(err("network_error", "本文の受信に失敗")));
      },
    );
    req.on("error", (e) => {
      if (signal.aborted) return done(err("timeout", "制限時間を超過"));
      if (e instanceof BlockedAddressError || e.message.includes("公開アドレスでない"))
        return done(err("blocked_address", "公開アドレスでないアドレスに解決された"));
      done(err("network_error", "接続に失敗"));
    });
    req.end();
  });

/** Content-Type または meta から文字コードを決めて文字列にする（Shift_JIS・EUC-JP のサイトがあるため） */
export function decodeBody(body: Buffer, contentType: string | null): string {
  const fromHeader = contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
  const head = body.subarray(0, 4096).toString("latin1");
  const fromMeta =
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? head.match(/<\?xml[^>]+encoding=["']([\w-]+)/i)?.[1];
  for (const label of [fromHeader, fromMeta, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label.toLowerCase()).decode(body);
    } catch {
      // 未知の文字コード名は次の候補へ
    }
  }
  return body.toString("utf8");
}

/** 公開アドレスだけを取得するページ取得関数を作る */
export function createPublicPageFetcher(options: PublicPageFetcherOptions = {}): PageFetcher {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;
  const userAgent = options.userAgent ?? "SiteOffer-discovery/1.0 (company existence check)";
  const transport = options.transport ?? nodeHttpTransport;
  const lookup = createPublicLookup(options.resolve);

  return async (raw, { signal } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let current = raw;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const checked = checkFetchableUrl(current);
        if (!checked.ok) return checked;
        if (controller.signal.aborted) return err("timeout", "制限時間を超過");
        const res = await Promise.race([
          transport(checked.value, { signal: controller.signal, maxBytes, lookup, userAgent }),
          new Promise<Result<never, PageFetchError>>((resolve) => {
            if (controller.signal.aborted) resolve(err("timeout", "制限時間を超過"));
            controller.signal.addEventListener("abort", () => resolve(err("timeout", "制限時間を超過")), {
              once: true,
            });
          }),
        ]);
        if (!res.ok) return res;
        const { status, location, contentType, body } = res.value;
        if (status >= 300 && status < 400 && location) {
          try {
            current = new URL(location, checked.value).href;
          } catch {
            return err("blocked_url", "リダイレクト先を解釈できない");
          }
          continue;
        }
        if (status !== 200) return err("http_status", `HTTP ${status}`);
        if (contentType && !/^(text\/html|application\/xhtml\+xml|text\/plain)\b/i.test(contentType)) {
          return err("unsupported_content_type", `HTMLでない応答（${contentType.split(";")[0]}）`);
        }
        return ok({ finalUrl: checked.value.href, status, contentType, body: decodeBody(body, contentType) });
      }
      return err("too_many_redirects", `リダイレクトが${maxRedirects}回を超えた`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
