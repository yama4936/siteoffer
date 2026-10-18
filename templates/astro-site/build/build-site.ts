/**
 * ビルドの入口。入力JSONのパスと出力ディレクトリを受け取り、Astroで静的サイトをビルドする。
 * 生成コンテナ・ワーカーから呼ぶ（CLIは build/cli.ts）。
 *
 * 手順：入力の検証 → モード決定 → delivery なら要確認マーカーの残存で失敗 → 画像を一時 public へコピー
 *       → 解決済み入力を一時ファイルへ書く → 子プロセスで `astro build`（最小限の環境変数だけを渡す）。
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MarkerHit } from "../lib/markers.ts";
import {
  MODE_ENV,
  markerErrorMessage,
  RESOLVED_INPUT_ENV,
  type ResolvedSite,
  resolveMode,
  validateSiteInput,
} from "../lib/resolve.ts";
import type { SiteImage, SiteInput, SiteMode } from "../schema/site-input.ts";

/** テンプレートのルート（astro.config.ts のあるディレクトリ）。 */
export const TEMPLATE_DIR = fileURLToPath(new URL("..", import.meta.url));
const ASTRO_BIN = path.join(TEMPLATE_DIR, "node_modules", "astro", "bin", "astro.mjs");

export interface BuildSiteOptions {
  /** 入力JSON（site.json）のパス。画像の相対パスはこのファイルのディレクトリを基準にする。 */
  inputPath: string;
  /** 出力ディレクトリ。既存なら中身を消してから出力する（clean=false で無効）。 */
  outDir: string;
  /** モードの明示指定。省略時は環境変数 SITEOFFER_SITE_MODE → 入力JSONの mode → demo。 */
  mode?: SiteMode | string;
  /** モードの環境変数を読む元（テスト用）。既定は process.env。 */
  env?: NodeJS.ProcessEnv;
  clean?: boolean;
  /** astro build の制限時間（ミリ秒）。既定 120 秒。 */
  timeoutMs?: number;
}

export type BuildFailureReason =
  | "invalid-input"
  | "unresolved-markers"
  | "missing-image"
  | "unsafe-out-dir"
  | "astro-build-failed";

export interface BuildSiteFailure {
  ok: false;
  reason: BuildFailureReason;
  message: string;
  mode?: SiteMode;
  errors?: string[];
  markers?: MarkerHit[];
  log?: string;
}

export type BuildSiteResult =
  | { ok: true; mode: SiteMode; outDir: string; markers: MarkerHit[]; log: string }
  | BuildSiteFailure;

function fail(
  reason: BuildFailureReason,
  message: string,
  extra: Partial<Omit<BuildSiteFailure, "ok" | "reason" | "message">> = {},
): BuildSiteFailure {
  return { ok: false, reason, message, ...extra };
}

/** 入力に含まれる画像の参照を全部集める（書き換えのため参照そのものを返す）。 */
function collectImages(input: SiteInput): SiteImage[] {
  const list: (SiteImage | undefined)[] = [
    input.company.logo,
    input.hero.image,
    ...(input.services?.items.map((i) => i.image) ?? []),
    ...(input.works?.items.map((i) => i.image) ?? []),
  ];
  return list.filter((i): i is SiteImage => !!i);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 消してはいけない場所を出力先にしていないか（ルート・ホーム・テンプレート・入力を含むディレクトリ）。 */
function unsafeOutDir(outDir: string, inputDir: string): string | null {
  const guarded = [TEMPLATE_DIR, inputDir, process.cwd(), homedir()];
  if (outDir === path.parse(outDir).root) return "ルートディレクトリは出力先にできない";
  for (const g of guarded) {
    if (isInside(path.resolve(g), outDir)) return `出力先 ${outDir} が ${g} を含むため消去できない`;
  }
  return null;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function removeBuildWork(dir: string, parent: string, prefix: string) {
  const target = path.resolve(dir);
  if (path.dirname(target) !== path.resolve(parent) || !path.basename(target).startsWith(prefix))
    throw new Error("ビルド用一時領域を確認できないため削除しません");
  await rm(target, { recursive: true, force: true });
}

function runAstro(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  cwd: string,
): Promise<{ code: number | null; log: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ASTRO_BIN, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => {
      log += d.toString();
    });
    child.stderr.on("data", (d) => {
      log += d.toString();
    });
    const timer = setTimeout(() => {
      log += `\n[build-site] ${timeoutMs}ms を超えたので中止した\n`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, log });
    });
  });
}

export async function buildSite(opts: BuildSiteOptions): Promise<BuildSiteResult> {
  const env = opts.env ?? process.env;
  const inputPath = path.resolve(opts.inputPath);
  const inputDir = path.dirname(inputPath);
  const outDir = path.resolve(opts.outDir);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(inputPath, "utf8"));
  } catch (e) {
    return fail("invalid-input", `入力JSONを読めない：${(e as Error).message}`);
  }
  const v = validateSiteInput(raw);
  if (!v.ok) return fail("invalid-input", "入力JSONがスキーマに合わない", { errors: v.errors });

  let mode: SiteMode;
  try {
    mode = resolveMode({ explicit: opts.mode, env: env[MODE_ENV], input: v.input.mode });
  } catch (e) {
    return fail("invalid-input", (e as Error).message);
  }
  if (mode === "delivery" && v.markers.length > 0) {
    return fail("unresolved-markers", markerErrorMessage(v.markers), { mode, markers: v.markers });
  }

  const unsafe = opts.clean === false ? null : unsafeOutDir(outDir, inputDir);
  if (unsafe) return fail("unsafe-out-dir", unsafe, { mode });

  const work = await mkdtemp(path.join(tmpdir(), "siteoffer-astro-"));
  let runtimeDir: string | undefined;
  try {
    // 画像を一時 public/images へコピーし、src を出力内の相対パスに書き換える
    const input = structuredClone(v.input);
    const publicDir = path.join(work, "public");
    await mkdir(path.join(publicDir, "images"), { recursive: true });
    const realInputDir = await realpath(inputDir);
    const missing: string[] = [];
    let n = 0;
    for (const img of collectImages(input)) {
      const src = path.resolve(inputDir, img.src);
      let real: string;
      try {
        real = await realpath(src);
        if (!(await stat(real)).isFile()) throw new Error("not a file");
      } catch {
        missing.push(img.src);
        continue;
      }
      if (!isInside(real, realInputDir)) {
        missing.push(`${img.src}（入力ディレクトリの外）`);
        continue;
      }
      n += 1;
      const name = `${String(n).padStart(2, "0")}-${path.basename(real).replace(/[^A-Za-z0-9._-]/g, "_")}`;
      await copyFile(real, path.join(publicDir, "images", name));
      img.src = `images/${name}`;
    }
    if (missing.length > 0) {
      return fail("missing-image", `画像が見つからない：${missing.join(", ")}`, { mode, errors: missing });
    }

    const resolvedFile = path.join(work, "resolved-site.json");
    const resolved: ResolvedSite = { mode, input };
    await writeFile(resolvedFile, JSON.stringify(resolved), "utf8");

    if (opts.clean !== false && (await exists(outDir))) await rm(outDir, { recursive: true, force: true });

    // アプリの秘密値を子プロセスへ渡さないよう、必要な変数だけにする（24.4）
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? work,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG ?? "C.UTF-8",
      NODE_ENV: "production",
      ASTRO_TELEMETRY_DISABLED: "1",
      [RESOLVED_INPUT_ENV]: resolvedFile,
      SITEOFFER_PUBLIC_DIR: publicDir,
      SITEOFFER_CACHE_DIR: path.join(work, "cache"),
    };
    // Astro falls back to <cwd>/.astro for prerender output outside cwd. A shared cwd makes
    // concurrent builds overwrite/delete each other's bundle. Stay below the template for
    // node_modules resolution, but give each invocation its own cwd (also writable in Docker).
    const runtimeParent = path.join(TEMPLATE_DIR, ".astro");
    await mkdir(runtimeParent, { recursive: true });
    runtimeDir = await mkdtemp(path.join(runtimeParent, "siteoffer-build-"));
    const { code, log } = await runAstro(
      ["build", "--root", TEMPLATE_DIR, "--outDir", outDir],
      childEnv,
      opts.timeoutMs ?? 120_000,
      runtimeDir,
    );
    if (code !== 0) {
      return fail("astro-build-failed", `astro build が失敗した（終了コード ${code}）`, { mode, log });
    }
    if (!(await exists(path.join(outDir, "index.html")))) {
      return fail("astro-build-failed", "astro build は成功したが index.html がない", { mode, log });
    }
    return { ok: true, mode, outDir, markers: v.markers, log };
  } finally {
    if (runtimeDir) await removeBuildWork(runtimeDir, path.join(TEMPLATE_DIR, ".astro"), "siteoffer-build-");
    await removeBuildWork(work, tmpdir(), "siteoffer-astro-");
  }
}

/** 出力ディレクトリのファイル一覧（相対パス）。テスト・検査用。 */
export async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, base)));
    else out.push(path.relative(base, p));
  }
  return out;
}
