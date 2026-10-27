/**
 * 改良資料（proposal.md）と改善後サイト（site/）の読み取り（サーバー側専用）。
 *
 * - 対象は企業詳細と同じ条件で見られる企業（findReadableCompany）。見られなければ not_found。
 * - 読むのは「最新の評価済み診断（site_audits.status = evaluated）」の artifactDir の中だけ。
 *   artifactDir は DB の値だけを使い、リクエストからは受け取らない。絶対パスでなければ使わない。
 * - 改善後サイトの配信は apps/preview の static.ts と同じ安全対策をとる
 *   （生のパスを1段ずつ確かめる・ドットで始まる名前を拒否・realpath で外に出ないことを確認・O_NOFOLLOW で開く）。
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { type Actor, err, ok, type Result } from "@siteoffer/core";
import { type DbOrTx, siteAudits } from "@siteoffer/db";
import { and, desc, eq } from "drizzle-orm";
import {
  artifactRoot,
  existsAsFile,
  isInside,
  openRegularFileInside,
  realpathOrNull,
  resolveImprovementSiteDir,
  siteRoot,
} from "./improvement-files.ts";
import { findReadableCompany } from "./queries.ts";

export { resolveImprovementSiteDir };

/** proposal.md の読み込み上限。これを超える資料は表示しない */
export const MAX_PROPOSAL_BYTES = 2 * 1024 * 1024;
/** 改善後サイトの1ファイルの上限 */
export const MAX_SITE_FILE_BYTES = 20 * 1024 * 1024;

export interface ImprovementSource {
  company: { id: string; name: string };
  /** 最新の評価済み診断。無ければ null */
  audit: {
    id: string;
    totalScore: string | null;
    scoreConfirmed: boolean | null;
    evaluatedAt: Date | null;
  } | null;
  /** 成果物ディレクトリ（絶対パス）。診断が無い・未設定・相対パスなら null */
  artifactDir: string | null;
}

/** 企業詳細と同じ権限で、最新の評価済み診断と成果物ディレクトリを返す */
export async function getImprovementSource(
  db: DbOrTx,
  actor: Actor | null,
  companyId: string,
): Promise<Result<ImprovementSource, "forbidden" | "not_found">> {
  const found = await findReadableCompany(db, actor, companyId);
  if (!found.ok) return found;
  const { company } = found.value;
  const [audit] = await db
    .select({
      id: siteAudits.id,
      totalScore: siteAudits.totalScore,
      scoreConfirmed: siteAudits.scoreConfirmed,
      evaluatedAt: siteAudits.evaluatedAt,
      artifactDir: siteAudits.artifactDir,
    })
    .from(siteAudits)
    .where(and(eq(siteAudits.companyId, company.id), eq(siteAudits.status, "evaluated")))
    .orderBy(desc(siteAudits.createdAt))
    .limit(1);
  const dir = audit?.artifactDir ?? null;
  return ok({
    company: { id: company.id, name: company.name },
    audit: audit
      ? {
          id: audit.id,
          totalScore: audit.totalScore,
          scoreConfirmed: audit.scoreConfirmed,
          evaluatedAt: audit.evaluatedAt,
        }
      : null,
    artifactDir: dir && path.isAbsolute(dir) ? dir : null,
  });
}

<<<<<<< Updated upstream
=======
// ---------- ファイルの安全な解決 ----------

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** root（実体のパス）の中の、名前 parts のディレクトリの実体のパス。外に出る・ディレクトリでなければ null */
async function realDirInside(rootReal: string, ...parts: string[]): Promise<string | null> {
  const real = await realpathOrNull(path.join(rootReal, ...parts));
  if (!real || !isInside(rootReal, real)) return null;
  try {
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

type OpenResult = { kind: "file"; handle: FileHandle; size: number; filePath: string } | { kind: "missing" };

/** 実体のパスが rootReal の中にあることを確かめてから O_NOFOLLOW で開き、通常のファイルなら返す */
async function openRegularFileInside(rootReal: string, candidate: string): Promise<OpenResult> {
  const real = await realpathOrNull(candidate);
  if (!real || !isInside(rootReal, real)) return { kind: "missing" };
  let handle: FileHandle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { kind: "missing" };
  }
  const stats = await handle.stat();
  if (!stats.isFile()) {
    await handle.close();
    return { kind: "missing" };
  }
  return { kind: "file", handle, size: stats.size, filePath: real };
}

/** 成果物ディレクトリの実体のパス。無い・ディレクトリでなければ null */
async function artifactRoot(artifactDir: string): Promise<string | null> {
  if (!path.isAbsolute(artifactDir)) return null;
  const real = await realpathOrNull(artifactDir);
  if (!real) return null;
  try {
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** 改善後サイトのルート（<artifactDir>/site の実体）。site がリンクで外を指す場合も null */
async function siteRoot(artifactDir: string): Promise<string | null> {
  const root = await artifactRoot(artifactDir);
  return root ? realDirInside(root, "site") : null;
}

/**
 * 共有用に使える改善後サイトの実体ディレクトリを返す。
 *
 * DB の artifactDir だけを起点にし、site が成果物の外を指すリンクでないことと
 * index.html が通常ファイルであることを確認する。共有側には評価資料を含む親ではなく、
 * この戻り値（<artifactDir>/site）だけを渡す。
 */
export async function resolveImprovementSiteDir(artifactDir: string | null): Promise<string | null> {
  if (!artifactDir) return null;
  const site = await siteRoot(artifactDir);
  if (!site) return null;
  return (await existsAsFile(site, path.join(site, "index.html"))) ? site : null;
}

>>>>>>> Stashed changes
// ---------- 改良資料 ----------

/** <artifactDir>/proposal.md を読む。無い・大きすぎる・外を指すリンクなら null */
export async function readProposalMarkdown(artifactDir: string): Promise<string | null> {
  const root = await artifactRoot(artifactDir);
  if (!root) return null;
  const opened = await openRegularFileInside(root, path.join(root, "proposal.md"));
  if (opened.kind !== "file") return null;
  try {
    if (opened.size > MAX_PROPOSAL_BYTES) return null;
    return await opened.handle.readFile("utf8");
  } finally {
    await opened.handle.close();
  }
}

export interface ImprovementAvailability {
  hasProposal: boolean;
  hasSite: boolean;
}

/** 改良資料（proposal.md）と改善後サイト（site/index.html）があるか */
export async function getImprovementAvailability(artifactDir: string | null): Promise<ImprovementAvailability> {
  if (!artifactDir) return { hasProposal: false, hasSite: false };
  const root = await artifactRoot(artifactDir);
  if (!root) return { hasProposal: false, hasSite: false };
  const site = await resolveImprovementSiteDir(artifactDir);
  return {
    hasProposal: await existsAsFile(root, path.join(root, "proposal.md")),
    hasSite: site !== null,
  };
}

// ---------- 改善後サイト ----------

/** 生のパスの1段を確かめてデコードする。拒否なら null（apps/preview の decodeSegment と同じ規則） */
export function decodeSegment(raw: string): string | null {
  if (raw === "") return null;
  if (/%(2f|5c|00)/i.test(raw) || raw.includes("\\")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded === "" || decoded.startsWith(".")) return null; // `.`・`..`・ドットファイル
  if (/[/\\\0]/.test(decoded)) return null;
  return decoded;
}

/**
 * `/site` より後ろの生のパス（デコード前）を段の配列にする。
 * null（`/site` そのもの）は呼び出し側でリダイレクトする。空文字・`/` はルート。拒否なら null。
 */
export function parseSitePath(rawRest: string): { segments: string[]; trailingSlash: boolean } | null {
  if (rawRest === "" || rawRest === "/") return { segments: [], trailingSlash: true };
  if (!rawRest.startsWith("/")) return null;
  const parts = rawRest.slice(1).split("/");
  const trailingSlash = parts[parts.length - 1] === "";
  if (trailingSlash) parts.pop();
  const segments: string[] = [];
  for (const p of parts) {
    const d = decodeSegment(p);
    if (d === null) return null;
    segments.push(d);
  }
  return { segments, trailingSlash };
}

export type SiteFileResult =
  | { kind: "file"; body: Buffer; contentType: string }
  /** ディレクトリを末尾スラッシュなしで指した。相対リンクが壊れないよう <dir>/index.html へ移す */
  | { kind: "redirect_index" }
  | { kind: "not_found"; reason: string };

const notFound = (reason: string): SiteFileResult => ({ kind: "not_found", reason });

/**
 * <artifactDir>/site/ の中から、生のパス rawRest（`/site` より後ろ、デコード前）のファイルを読む。
 * ディレクトリ（末尾 `/`）は index.html を返す。
 */
export async function readSiteFile(artifactDir: string, rawRest: string): Promise<SiteFileResult> {
  const parsed = parseSitePath(rawRest);
  if (!parsed) return notFound("bad_path");
  const root = await siteRoot(artifactDir);
  if (!root) return notFound("site_missing");

  const real = await realpathOrNull(path.join(root, ...parsed.segments));
  if (!real) return notFound("missing");
  if (!isInside(root, real)) return notFound("outside_root");

  let target = real;
  if ((await stat(/* turbopackIgnore: true */ real)).isDirectory()) {
    if (!parsed.trailingSlash) return { kind: "redirect_index" };
    target = path.join(real, "index.html");
  } else if (parsed.trailingSlash) {
    return notFound("not_a_dir");
  }

  const opened = await openRegularFileInside(root, target);
  if (opened.kind !== "file") return notFound("missing");
  try {
    if (opened.size > MAX_SITE_FILE_BYTES) return notFound("too_large");
    return { kind: "file", body: await opened.handle.readFile(), contentType: contentTypeFor(opened.filePath) };
  } finally {
    await opened.handle.close();
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** 拡張子から Content-Type を決める。不明なものは application/octet-stream（nosniff と合わせて実行させない） */
export function contentTypeFor(filePath: string): string {
  return TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 改善後サイトの応答に付けるヘッダー（apps/preview の securityHeaders に合わせる）。
 * 営業アプリと同じオリジンで配信するため、外部への読み込み・送信・埋め込みを禁じる。
 */
export function siteSecurityHeaders(): Record<string, string> {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    // 生成サイトは CSS を HTML に埋め込むことがある
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "media-src 'self'",
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Cache-Control": "private, no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}

/** 改善後サイトの配信（Route Handler 用）の結果。HTTP への変換は route.ts が行う */
export type SiteResponse =
  | { kind: "file"; body: Buffer; contentType: string }
  | { kind: "redirect"; location: string }
  | { kind: "not_found" };

/** `/sales/companies/<id>/site` の生のパス（デコード前）から、`/site` より後ろを取り出す。対象外なら undefined */
export function splitSitePath(rawPathname: string, companyId: string): string | null | undefined {
  const prefix = `/sales/companies/${companyId}/site`;
  if (rawPathname === prefix) return null;
  if (!rawPathname.startsWith(`${prefix}/`)) return undefined;
  return rawPathname.slice(prefix.length);
}

/**
 * 改善後サイトの1リクエストを処理する。権限（企業詳細と同じ）→ 成果物ディレクトリ → ファイルの順に確かめる。
 * 見られない企業・ファイルが無い・拒否したパスはすべて not_found（存在を明かさない）。
 */
export async function serveImprovedSite(
  db: DbOrTx,
  actor: Actor | null,
  companyId: string,
  rawPathname: string,
): Promise<Result<SiteResponse, "forbidden">> {
  const src = await getImprovementSource(db, actor, companyId);
  if (!src.ok) return src.error === "forbidden" ? err("forbidden") : ok({ kind: "not_found" });
  // companyId はここまでで UUID の形式と権限を確かめ済み。URL の表記（大文字・小文字）のまま使う
  const rest = splitSitePath(rawPathname, companyId);
  if (rest === undefined) return ok({ kind: "not_found" });
  const base = `/sales/companies/${companyId}/site`;
  // Next.js は末尾スラッシュを外すリダイレクトをするため、`/site/` ではなく `/site/index.html` へ移す
  if (rest === null) return ok({ kind: "redirect", location: `${base}/index.html` });
  if (!src.value.artifactDir) return ok({ kind: "not_found" });
  const r = await readSiteFile(src.value.artifactDir, rest);
  if (r.kind === "redirect_index") {
    return ok({ kind: "redirect", location: `${base}${rest}/index.html` });
  }
  if (r.kind === "not_found") return ok({ kind: "not_found" });
  return ok(r);
}
