/**
 * スマホ幅での表示崩れの検査。ヘッドレスChromeでページを開き、横スクロール幅（scrollWidth）が画面幅を超えないかを測る。
 *
 * 方式：dist をローカルのHTTPサーバー（127.0.0.1・ランダムなポート）で配信し、HTMLの応答にだけ計測用の
 * スクリプトを差し込む（dist のファイルは書き換えない）。ヘッドレスChromeはウィンドウ幅に下限（500px程度）が
 * あるため、指定幅の iframe にページを読み込む計測用ページを使う。Chrome を --dump-dom で起動し、
 * iframe 内で測った結果を親ページの meta 要素から読む。
 * Chrome が見つからない・起動できない場合は status: "unavailable" を返す（失敗扱いにはしない）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export const DEFAULT_CHROME_PATHS = [
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export interface MobilePageResult {
  page: string;
  /** 指定した画面幅。 */
  width: number;
  /** Chrome内で測った画面幅（window.innerWidth）。 */
  innerWidth: number;
  /** ページの横幅（document の scrollWidth）。 */
  scrollWidth: number;
  overflow: boolean;
  /** 画面幅をはみ出した要素（最大5件）。 */
  offenders: string[];
}

export type MobileCheckResult =
  | { status: "measured"; results: MobilePageResult[] }
  | { status: "unavailable"; reason: string };

export interface MobileCheckOptions {
  chromePath?: string;
  /** 画面幅（CSSピクセル）。既定 375。 */
  width?: number;
  timeoutMs?: number;
}

const MEASURE_META = "x-siteoffer-measure";
const MEASURE_PATH = "/__siteoffer_measure__";

function measureScript(): string {
  return `<script>(function(){function run(){var d=document.documentElement,b=document.body,w=window.innerWidth;var off=[];var all=b?b.getElementsByTagName("*"):[];for(var i=0;i<all.length&&off.length<5;i++){var r=all[i].getBoundingClientRect();if(r.right>w+1){var e=all[i];off.push(e.tagName.toLowerCase()+(e.id?"#"+e.id:"")+(e.className&&typeof e.className==="string"?"."+e.className.trim().split(/\\s+/).join("."):""));}}var t=window.parent&&window.parent!==window?window.parent.document:document;var m=t.createElement("meta");m.name="${MEASURE_META}";m.content=JSON.stringify({innerWidth:w,scrollWidth:Math.max(d.scrollWidth,b?b.scrollWidth:0),offenders:off});t.head.appendChild(m);}if(document.readyState==="complete"){setTimeout(run,50);}else{window.addEventListener("load",function(){setTimeout(run,50);});}})();</script>`;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};

/** dist を配信するサーバー。HTMLには計測スクリプトを差し込む。 */
function serveDist(distDir: string): Promise<{ server: Server; port: number }> {
  const root = path.resolve(distDir);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === MEASURE_PATH) {
        const page = url.searchParams.get("page") ?? "/";
        const w = Number(url.searchParams.get("w") ?? "375");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><iframe src="${encodeURI(page)}" style="width:${w}px;height:800px;border:0;display:block"></iframe></body></html>`,
        );
        return;
      }
      let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(root)) throw new Error("outside");
      if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, "index.html");
      let body: Buffer | string = await readFile(file);
      const ext = path.extname(file).toLowerCase();
      if (ext === ".html") {
        const html = body.toString("utf8");
        body = html.includes("</body>") ? html.replace("</body>", `${measureScript()}</body>`) : html + measureScript();
      }
      res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

function runChrome(
  chrome: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function findChrome(explicit?: string): string | undefined {
  const candidates = [explicit, process.env.CHROME_PATH, ...DEFAULT_CHROME_PATHS].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p));
}

/** dist のページ（相対パスのリスト）をスマホ幅で開き、横スクロールの有無を測る。 */
export async function checkMobileLayout(
  distDir: string,
  pages: string[],
  opts: MobileCheckOptions = {},
): Promise<MobileCheckResult> {
  const chrome = findChrome(opts.chromePath);
  if (!chrome) return { status: "unavailable", reason: "Chrome が見つからない（CHROME_PATH で指定できる）" };
  const width = opts.width ?? 375;
  const { server, port } = await serveDist(distDir);
  const profile = await mkdtemp(path.join(tmpdir(), "siteoffer-chrome-"));
  try {
    const results: MobilePageResult[] = [];
    for (const page of pages) {
      const urlPath = page.replace(/\\/g, "/").replace(/(^|\/)index\.html$/, "$1");
      const url = `http://127.0.0.1:${port}${MEASURE_PATH}?w=${width}&page=${encodeURIComponent(`/${urlPath}`)}`;
      const args = [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-extensions",
        "--hide-scrollbars",
        `--user-data-dir=${profile}`,
        `--window-size=${Math.max(width + 100, 800)},1000`,
        "--virtual-time-budget=5000",
        "--dump-dom",
        url,
      ];
      if (typeof process.getuid === "function" && process.getuid() === 0) args.unshift("--no-sandbox");
      const out = await runChrome(chrome, args, opts.timeoutMs ?? 60_000);
      const m = out.stdout.match(new RegExp(`<meta name="${MEASURE_META}" content="([^"]*)"`));
      if (!m) {
        return {
          status: "unavailable",
          reason: `Chrome から計測結果を得られなかった（終了コード ${out.code}）：${out.stderr.trim().split("\n").slice(-3).join(" / ")}`,
        };
      }
      const data = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as {
        innerWidth: number;
        scrollWidth: number;
        offenders: string[];
      };
      results.push({
        page,
        width,
        innerWidth: data.innerWidth,
        scrollWidth: data.scrollWidth,
        overflow: data.scrollWidth > data.innerWidth + 1,
        offenders: data.offenders,
      });
    }
    return { status: "measured", results };
  } finally {
    await new Promise((r) => server.close(r));
    await rm(profile, { recursive: true, force: true });
  }
}
