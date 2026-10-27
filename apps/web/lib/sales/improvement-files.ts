/**
 * 成果物ディレクトリ内のファイルの安全な解決（サーバー側専用）。
 * DBに依存しないので、取り込みスクリプトからも使える（improvement.ts から分離）。
 */
import { constants } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveArtifactFile } from "../../../preview/src/static";

export function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

export async function realpathOrNull(p: string): Promise<string | null> {
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
    return (await stat(/* turbopackIgnore: true */ real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

type OpenResult = { kind: "file"; handle: FileHandle; size: number; filePath: string } | { kind: "missing" };

/** 実体のパスが rootReal の中にあることを確かめてから O_NOFOLLOW で開き、通常のファイルなら返す */
export async function openRegularFileInside(rootReal: string, candidate: string): Promise<OpenResult> {
  const real = await realpathOrNull(candidate);
  if (!real || !isInside(rootReal, real)) return { kind: "missing" };
  let handle: FileHandle;
  try {
    handle = await open(/* turbopackIgnore: true */ real, constants.O_RDONLY | constants.O_NOFOLLOW);
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
export async function artifactRoot(artifactDir: string): Promise<string | null> {
  if (!path.isAbsolute(artifactDir)) return null;
  const real = await realpathOrNull(artifactDir);
  if (!real) return null;
  try {
    return (await stat(/* turbopackIgnore: true */ real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** 改善後サイトのルート（<artifactDir>/site の実体）。site がリンクで外を指す場合も null */
export async function siteRoot(artifactDir: string): Promise<string | null> {
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

export async function existsAsFile(rootReal: string, candidate: string): Promise<boolean> {
  const opened = await openRegularFileInside(rootReal, candidate);
  if (opened.kind !== "file") return false;
  await opened.handle.close();
  return true;
}

/** DB は提案デモの置き場所を記録するだけ。index.html を実際に配信できるときだけ「デモあり」とする */
export async function hasStaticPreview(directory: string | null): Promise<boolean> {
  if (!directory || !path.isAbsolute(directory)) return false;
  const file = await resolveArtifactFile(directory, "/index.html");
  if (file.kind !== "file") return false;
  await file.handle.close();
  return true;
}

/** 改善案として見せられる提案デモか。固定サンプル（mock）はまだ作成していない扱いにする */
export async function hasProposalDemo(version: { demoArtifactDir: string | null; content: unknown }): Promise<boolean> {
  if ((version.content as { generator?: unknown } | null)?.generator === "mock") return false;
  return hasStaticPreview(version.demoArtifactDir);
}
