import { copyFile, lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * スキル実行の作業ディレクトリ（隔離コンテナの /work）の準備と、成果物の取り出し。
 * 取り出しは通常のファイルとディレクトリだけを写す。リンク・特殊ファイルは写さず、件数と容量に上限を置く
 * （コンテナ内のCodexは取得したWebページを読むため、成果物を信用しない）。
 */

/** 作業ディレクトリへ写さないもの */
const SKIP_NAMES = new Set(["__pycache__", ".DS_Store", "node_modules"]);

export interface CopyLimits {
  maxFiles: number;
  maxBytes: number;
}

export const OUTPUT_LIMITS: CopyLimits = { maxFiles: 5000, maxBytes: 500 * 1024 * 1024 };

export interface CopyReport {
  files: string[];
  /** 写さなかったもの（リンク・特殊ファイル・上書きしない既存ファイル） */
  skipped: string[];
}

export class OutputLimitError extends Error {
  override name = "OutputLimitError";
}

/**
 * src の中身を dest へ写す。overwrite=false なら既存ファイルは残す。
 * リンクは辿らずに飛ばす。上限を超えたら OutputLimitError（それまでに写したファイルは残る）。
 */
export async function copyTree(
  src: string,
  dest: string,
  opts: { overwrite: boolean; limits?: CopyLimits; filter?: (rel: string) => boolean },
): Promise<CopyReport> {
  const limits = opts.limits ?? OUTPUT_LIMITS;
  const report: CopyReport = { files: [], skipped: [] };
  let bytes = 0;
  const walk = async (rel: string) => {
    const from = path.join(src, rel);
    const info = await lstat(from);
    if (info.isSymbolicLink() || !(info.isDirectory() || info.isFile())) {
      report.skipped.push(rel);
      return;
    }
    if (rel && opts.filter && !opts.filter(rel)) return;
    if (info.isDirectory()) {
      await mkdir(path.join(dest, rel), { recursive: true });
      for (const name of (await readdir(from)).sort()) {
        if (SKIP_NAMES.has(name)) continue;
        await walk(path.join(rel, name));
      }
      return;
    }
    const to = path.join(dest, rel);
    const existing = await lstat(to).catch(() => null);
    if (existing && (existing.isSymbolicLink() || !existing.isFile() || !opts.overwrite)) {
      report.skipped.push(rel);
      return;
    }
    bytes += info.size;
    if (report.files.length + 1 > limits.maxFiles || bytes > limits.maxBytes)
      throw new OutputLimitError(`成果物が上限（${limits.maxFiles}件・${limits.maxBytes}バイト）を超えました`);
    await copyFile(from, to);
    report.files.push(rel);
  };
  await walk("");
  return report;
}

/** 作業ディレクトリ内の相対パスが、外へ出ずに通常のディレクトリを指すか */
export async function isPlainDir(root: string, rel: string): Promise<boolean> {
  const resolved = path.resolve(root, rel);
  if (resolved === path.resolve(root)) return true;
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return false;
  // 途中の要素もリンクでないことを確かめる
  let current = path.resolve(root);
  for (const part of path.relative(root, resolved).split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return false;
  }
  return true;
}

/** 作業ディレクトリ内の通常のJSONファイルを読む。リンク・不正なJSONは null */
export async function readPlainJson(root: string, rel: string): Promise<unknown | null> {
  const file = path.join(root, rel);
  if (!(await isPlainDir(root, path.dirname(rel)))) return null;
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > 20 * 1024 * 1024) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function dirExists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false;
}
