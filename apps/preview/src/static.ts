import { constants, type Stats } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * 成果物ディレクトリの中の静的ファイルを安全に開く。
 *
 * 守ること（成果物ディレクトリの外に出さない）：
 * - パスはURLの生の値（デコード前）を `/` で区切って1段ずつ確かめる。WHATWG URL の正規化には頼らない。
 * - エンコードされた区切り（%2F・%5C）、`\`、NUL、空の段（`//`）、`.`・`..`、ドットで始まる名前は拒否する。
 * - シンボリックリンクは実体のパス（realpath）が成果物ディレクトリの中にあることを確かめる。
 *   開くときは O_NOFOLLOW を付け、確認後に差し替えられたリンクもたどらない。
 * - 通常のファイルだけを返す。ディレクトリは index.html を探す（末尾が `/` でなければリダイレクトを指示する）。
 */
export type ResolveResult =
  | { kind: "file"; handle: FileHandle; stats: Stats; filePath: string }
  | { kind: "redirect_dir" }
  | { kind: "not_found"; reason: string };

const notFound = (reason: string): ResolveResult => ({ kind: "not_found", reason });

/** 生のパスの1段を確かめてデコードする。拒否なら null */
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
 * 生のパス（`/s/<token>` より後ろ。先頭は `/`）を、成果物ディレクトリの中の段の配列にする。
 * 末尾が `/` なら最後に index.html を補う。拒否なら null。
 */
export function parseRestPath(rawRest: string): { segments: string[]; trailingSlash: boolean } | null {
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

/** 実体のパスを確かめてから O_NOFOLLOW で開き、通常のファイルなら返す */
async function openRegularFile(rootReal: string, candidate: string): Promise<ResolveResult> {
  const real = await realpathOrNull(candidate);
  if (!real) return notFound("missing");
  if (!isInside(rootReal, real)) return notFound("outside_root");
  let handle: FileHandle;
  try {
    handle = await open(/* turbopackIgnore: true */ real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return notFound("open_failed");
  }
  const stats = await handle.stat();
  if (!stats.isFile()) {
    await handle.close();
    return notFound("not_a_file");
  }
  return { kind: "file", handle, stats, filePath: real };
}

/**
 * 成果物ディレクトリ（artifactDir）から、生のパス rawRest のファイルを開く。
 * 呼び出し側は返した handle を必ず閉じる。
 */
export async function resolveArtifactFile(artifactDir: string, rawRest: string): Promise<ResolveResult> {
  const parsed = parseRestPath(rawRest);
  if (!parsed) return notFound("bad_path");
  const rootReal = await realpathOrNull(artifactDir);
  if (!rootReal) return notFound("root_missing");
  const rootStat = await stat(/* turbopackIgnore: true */ rootReal);
  if (!rootStat.isDirectory()) return notFound("root_not_dir");

  const candidate = path.join(/* turbopackIgnore: true */ rootReal, ...parsed.segments);
  const real = await realpathOrNull(candidate);
  if (!real) return notFound("missing");
  if (!isInside(rootReal, real)) return notFound("outside_root");

  const s = await stat(/* turbopackIgnore: true */ real);
  if (s.isDirectory()) {
    if (!parsed.trailingSlash && parsed.segments.length > 0) return { kind: "redirect_dir" };
    return openRegularFile(rootReal, path.join(real, "index.html"));
  }
  if (parsed.trailingSlash) return notFound("not_a_dir");
  return openRegularFile(rootReal, real);
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
