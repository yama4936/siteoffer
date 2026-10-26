import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { type Clock, isShareTokenFormat, systemClock, verifyDeliveryPreview, verifyShareLink } from "@siteoffer/core";
import type { DbOrTx } from "@siteoffer/db";
import { contentTypeFor, resolveArtifactFile } from "./static.ts";

/** プレビュー配信の既定ポート（webは3100。3000番はこのマシンの別プロセスが使っている） */
export const DEFAULT_PREVIEW_PORT = 3200;

/** 既定で埋め込み（iframe）を許す相手。営業・運営画面（web）からPC・スマホ表示を確認するため */
export const DEFAULT_FRAME_ANCESTORS = ["'self'", "http://localhost:3100", "http://127.0.0.1:3100"];

export interface PreviewServerOptions {
  db: DbOrTx;
  clock?: Clock;
  /** CSP の frame-ancestors に並べる値 */
  frameAncestors?: string[];
  /** artifactDir が相対パスのときの基準。未指定なら相対パスの成果物は配信しない */
  artifactBaseDir?: string;
  /** 拒否・失敗の記録先。トークンは渡さない */
  log?: (message: string) => void;
}

/** プレビュー用の非公式表示（テンプレートの data-demo-notice が無い提案デモに差し込む） */
const DEMO_NOTICE_HTML =
  '<div role="note" data-demo-notice="preview" style="position:sticky;top:0;z-index:2147483647;margin:0;padding:8px 12px;background:#fff3cd;color:#3d2e00;border-bottom:1px solid #e0c97a;font:14px/1.5 sans-serif;text-align:center">' +
  "これは非公式の改善提案デモです。企業の正式なサイトではありません。</div>";

/** すべての応答に付けるヘッダー。Set-Cookie は付けない（アプリの認証情報に触れない・11章） */
export function securityHeaders(frameAncestors: string[]): Record<string, string> {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "worker-src 'none'",
    // テンプレートは CSS を HTML に埋め込む（inlineStylesheets: always）
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "media-src 'self'",
    // 提案ページから外部への送信（問い合わせフォーム・計測タグ）をさせない（11章）
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    `frame-ancestors ${frameAncestors.length > 0 ? frameAncestors.join(" ") : "'none'"}`,
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    // 取り消し・期限切れをすぐ反映するため、キャッシュさせない
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}

function sendText(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...extra });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

const notFound = (res: ServerResponse) => sendText(res, 404, "Not Found");

/** HTMLに非公式表示が無ければ <body> の直後に差し込む */
export function injectDemoNotice(html: string): string {
  if (html.includes("data-demo-notice")) return html;
  const m = /<body\b[^>]*>/i.exec(html);
  if (!m) return DEMO_NOTICE_HTML + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + DEMO_NOTICE_HTML + html.slice(at);
}

/** 顧客共有 /s/ と運営専用 /internal/ を分け、後続の生パスを保持する。 */
function splitSharePath(rawUrl: string): { token: string; rest: string | null; internal: boolean } | null {
  const rawPath = rawUrl.split(/[?#]/, 1)[0] ?? "";
  const m = /^\/(s|internal)\/([^/]*)(\/.*)?$/.exec(rawPath);
  if (!m) return null;
  return { token: m[2] ?? "", rest: m[3] ?? null, internal: m[1] === "internal" };
}

type ResolvedOptions = PreviewServerOptions & {
  clock: Clock;
  frameAncestors: string[];
  log: (message: string) => void;
};

async function handle(opts: ResolvedOptions, req: IncomingMessage, res: ServerResponse) {
  // Cookie・Authorization 等のリクエストヘッダーは読まない（認証はURLのトークンだけ）
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
    return;
  }
  const parts = splitSharePath(req.url ?? "");
  if (!parts || !isShareTokenFormat(parts.token)) return notFound(res);
  // 運営画面はHEADで配信成功を確認してから埋め込む。許可済みの管理画面オリジンだけ。
  if (parts.internal) {
    res.setHeader("Vary", "Origin");
    if (req.headers.origin && opts.frameAncestors.includes(req.headers.origin))
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
  }

  const verified = parts.internal
    ? await verifyDeliveryPreview(opts.db, opts.clock, parts.token)
    : await verifyShareLink(opts.db, opts.clock, parts.token);
  if (!verified.ok) {
    opts.log(`share link rejected: ${verified.message ?? verified.error}`);
    return notFound(res);
  }
  const link = verified.value;

  if (parts.rest === null) {
    // 相対リンクが解決できるよう、末尾に / を付ける
    res.writeHead(308, { Location: `/${parts.internal ? "internal" : "s"}/${parts.token}/` });
    res.end();
    return;
  }

  let artifactDir = link.artifactDir;
  if (!path.isAbsolute(artifactDir)) {
    if (!opts.artifactBaseDir) {
      opts.log(`share link ${link.linkId}: artifact dir is relative and no base dir is configured`);
      return notFound(res);
    }
    artifactDir = path.resolve(opts.artifactBaseDir, artifactDir);
  }

  const resolved = await resolveArtifactFile(artifactDir, parts.rest);
  if (resolved.kind === "redirect_dir") {
    const rawPath = (req.url ?? "").split(/[?#]/, 1)[0] ?? "";
    res.writeHead(308, { Location: `${rawPath}/` });
    res.end();
    return;
  }
  if (resolved.kind === "not_found") {
    opts.log(`share link ${link.linkId}: not found (${resolved.reason})`);
    return notFound(res);
  }

  const { handle: fh, stats, filePath } = resolved;
  try {
    const type = contentTypeFor(filePath);
    if (type.startsWith("text/html") && link.purpose === "proposal") {
      const body = Buffer.from(injectDemoNotice(await fh.readFile("utf8")), "utf8");
      res.writeHead(200, { "Content-Type": type, "Content-Length": String(body.length) });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": String(stats.size) });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = fh.createReadStream({ autoClose: false });
    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.on("end", resolve);
      res.on("close", resolve);
      stream.pipe(res);
    });
  } finally {
    await fh.close();
  }
}

/**
 * プレビュー配信のHTTPサーバーを作る（listen はしない）。
 * `/s/<token>/...` は顧客共有、`/internal/<token>/...` は運営セッションに結び付く確認用。
 * 対象の版の成果物ディレクトリから静的ファイルだけを返す。
 * 不明・期限切れ・取り消し済みのトークンは 404（存在を明かさない）。
 */
export function createPreviewServer(options: PreviewServerOptions): Server {
  const opts: ResolvedOptions = {
    clock: systemClock,
    frameAncestors: DEFAULT_FRAME_ANCESTORS,
    log: () => {},
    ...options,
  };
  const headers = securityHeaders(opts.frameAncestors);
  return createServer((req, res) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    handle(opts, req, res).catch((e: unknown) => {
      opts.log(`preview error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) sendText(res, 500, "Internal Server Error");
      else res.destroy();
    });
  });
}

export interface StartedPreviewServer {
  server: Server;
  port: number;
  /** 例：http://127.0.0.1:3200 */
  url: string;
  close(): Promise<void>;
}

/** プレビュー配信を起動する。テストでは port: 0 で空いているポートを使う */
export async function startPreviewServer(
  options: PreviewServerOptions & { port?: number; host?: string },
): Promise<StartedPreviewServer> {
  const { port = DEFAULT_PREVIEW_PORT, host = "127.0.0.1", ...rest } = options;
  const server = createPreviewServer(rest);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const actual = (server.address() as AddressInfo).port;
  return {
    server,
    port: actual,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${actual}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}
