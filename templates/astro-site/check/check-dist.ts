/**
 * ビルド済みの dist の検査（24.5）。
 *
 * 検査項目：
 * - 内部リンク・ページ内アンカーのリンク切れ、mailto/tel の空リンク
 * - 画像ファイルの欠落、alt の欠落（属性なし＝エラー、空＝警告）
 * - 要確認マーカーの残存（delivery はエラー。demo は表示要素なら警告、生のマーカー文字列ならエラー）
 * - デモ表示（ページ上部とフッターの非公式表示・noindex）の有無。delivery では逆に残っていればエラー
 * - viewport meta の有無
 * - 外部の読み込み（スクリプト・スタイル・フォント・画像・iframe）と問い合わせフォームの混入
 * - スマホ幅での横スクロール（mobile: true のとき。ヘッドレスChrome。check/mobile.ts）
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type HTMLElement, parse } from "node-html-parser";
import { MARKER_ATTRIBUTE, markerRegex } from "../lib/markers.ts";
import type { SiteMode } from "../schema/site-input.ts";
import { checkMobileLayout, type MobileCheckOptions, type MobileCheckResult } from "./mobile.ts";

export type CheckIssueKind =
  | "broken-link"
  | "broken-anchor"
  | "missing-image"
  | "missing-alt"
  | "empty-alt"
  | "unresolved-marker"
  | "demo-notice-missing"
  | "demo-notice-unexpected"
  | "noindex-missing"
  | "noindex-unexpected"
  | "missing-viewport"
  | "external-resource"
  | "form-present"
  | "horizontal-overflow"
  | "no-html";

export type CheckSeverity = "error" | "warning";

export interface CheckIssue {
  kind: CheckIssueKind;
  severity: CheckSeverity;
  /** dist からの相対パス。 */
  file: string;
  detail: string;
}

export interface CheckOptions {
  /** 期待するモード。省略時は各ページの <html data-mode> から読む（なければ要確認は厳しく、デモ表示は検査しない）。 */
  mode?: SiteMode;
  /** スマホ幅の検査を行う（ヘッドレスChrome）。 */
  mobile?: boolean;
  mobileOptions?: MobileCheckOptions;
}

export interface CheckReport {
  /** エラーが1件もなければ true（警告は許容）。 */
  ok: boolean;
  distDir: string;
  pages: string[];
  issues: CheckIssue[];
  /** 種類ごとの件数。 */
  counts: Partial<Record<CheckIssueKind, number>>;
  /** スマホ幅の検査。mobile: false なら "skipped"。 */
  mobile: MobileCheckResult | { status: "skipped" };
}

/** デモ表示の文面に必ず含める語。 */
export const DEMO_NOTICE_PHRASES = ["非公式", "正式なサイトではありません"];

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

function isExternal(url: string): boolean {
  return /^(https?:)?\/\//i.test(url);
}

/** dist 内の参照先ファイルを解決する（見つからなければ null）。 */
function resolveTarget(files: Set<string>, fromPage: string, urlPath: string): string | null {
  let p = decodeURIComponent(urlPath);
  p = p.startsWith("/") ? p.slice(1) : path.posix.join(path.posix.dirname(fromPage), p);
  p = path.posix.normalize(p);
  if (p === "." || p === "") p = "";
  if (p.startsWith("..")) return null;
  const candidates = p === "" || p.endsWith("/") ? [`${p}index.html`] : [p, `${p}/index.html`, `${p}.html`];
  return candidates.find((c) => files.has(c)) ?? null;
}

function idsOf(root: HTMLElement): Set<string> {
  const ids = new Set<string>();
  for (const el of root.querySelectorAll("[id]")) ids.add(el.getAttribute("id") ?? "");
  for (const el of root.querySelectorAll("a[name]")) ids.add(el.getAttribute("name") ?? "");
  return ids;
}

export async function checkDist(distDir: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const dist = path.resolve(distDir);
  const issues: CheckIssue[] = [];
  const add = (kind: CheckIssueKind, severity: CheckSeverity, file: string, detail: string) =>
    issues.push({ kind, severity, file, detail });

  const fileList = await walk(dist);
  const files = new Set(fileList);
  const pages = fileList.filter((f) => f.endsWith(".html")).sort();
  if (pages.length === 0) add("no-html", "error", ".", "HTMLファイルがない");

  const parsed = new Map<string, HTMLElement>();
  for (const page of pages) parsed.set(page, parse(await readFile(path.join(dist, page), "utf8"), { comment: false }));
  const idCache = new Map<string, Set<string>>();
  const idsFor = (page: string) => {
    let s = idCache.get(page);
    if (!s) {
      s = idsOf(parsed.get(page)!);
      idCache.set(page, s);
    }
    return s;
  };

  for (const page of pages) {
    const root = parsed.get(page)!;
    const htmlMode = root.querySelector("html")?.getAttribute("data-mode");
    const mode: SiteMode | undefined =
      opts.mode ?? (htmlMode === "demo" || htmlMode === "delivery" ? (htmlMode as SiteMode) : undefined);

    // viewport
    const viewport = root.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
    if (!/width\s*=\s*device-width/.test(viewport)) {
      add("missing-viewport", "error", page, viewport ? `viewport が不適切：${viewport}` : "viewport meta がない");
    }

    // リンク
    for (const a of root.querySelectorAll("a[href]")) {
      const href = (a.getAttribute("href") ?? "").trim();
      if (href === "" || href === "#") {
        add("broken-link", "warning", page, `移動先のないリンク：href="${href}"（${a.text.trim().slice(0, 30)}）`);
        continue;
      }
      if (/^mailto:/i.test(href)) {
        if (!/^mailto:[^@\s]+@[^@\s]+$/i.test(href.split("?")[0]!))
          add("broken-link", "error", page, `不正な mailto：${href}`);
        continue;
      }
      if (/^tel:/i.test(href)) {
        if (!/^tel:\+?[0-9-]{3,}$/i.test(href)) add("broken-link", "error", page, `不正な tel：${href}`);
        continue;
      }
      if (isExternal(href) || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // 外部リンクは検査対象外
      const [pathAndQuery, hash] = href.split("#", 2) as [string, string | undefined];
      const urlPath = pathAndQuery.split("?")[0]!;
      const target = urlPath === "" ? page : resolveTarget(files, page, urlPath);
      if (!target) {
        add("broken-link", "error", page, `リンク先がない：${href}`);
        continue;
      }
      if (hash && target.endsWith(".html") && !idsFor(target).has(decodeURIComponent(hash))) {
        add("broken-anchor", "error", page, `アンカーの移動先がない：${href}`);
      }
    }

    // 画像
    for (const img of root.querySelectorAll("img")) {
      const src = (img.getAttribute("src") ?? "").trim();
      if (!img.hasAttribute("alt")) add("missing-alt", "error", page, `alt がない：${src}`);
      else if ((img.getAttribute("alt") ?? "").trim() === "") add("empty-alt", "warning", page, `alt が空：${src}`);
      if (src === "") add("missing-image", "error", page, "src のない img");
      else if (isExternal(src)) add("external-resource", "error", page, `外部の画像：${src}`);
      else if (!src.startsWith("data:") && !resolveTarget(files, page, src.split(/[?#]/)[0]!)) {
        add("missing-image", "error", page, `画像ファイルがない：${src}`);
      }
    }
    // CSS内の url()（style要素・style属性）
    const cssTexts = [
      ...root.querySelectorAll("style").map((s) => s.text),
      ...root.querySelectorAll("[style]").map((e) => e.getAttribute("style") ?? ""),
    ];
    for (const css of cssTexts) {
      for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const u = m[1]!.trim();
        if (u.startsWith("data:") || u.startsWith("#")) continue;
        if (isExternal(u)) add("external-resource", "error", page, `CSSから外部を読み込む：${u}`);
        else if (!resolveTarget(files, page, u.split(/[?#]/)[0]!))
          add("missing-image", "error", page, `CSSの参照先がない：${u}`);
      }
      if (/@import\s+(url\()?\s*['"]?(https?:)?\/\//i.test(css))
        add("external-resource", "error", page, "CSSの @import で外部を読み込む");
    }

    // 外部の読み込み・計測タグ・フォーム
    for (const el of root.querySelectorAll(
      "script[src], link[href], iframe[src], source[src], video[src], audio[src]",
    )) {
      const u = el.getAttribute("src") ?? el.getAttribute("href") ?? "";
      const rel = el.getAttribute("rel") ?? "";
      if (el.tagName === "LINK" && /canonical|alternate/i.test(rel)) continue;
      if (isExternal(u)) add("external-resource", "error", page, `外部の読み込み：<${el.tagName.toLowerCase()}> ${u}`);
    }
    for (const s of root.querySelectorAll("script")) {
      if (/googletagmanager|google-analytics|gtag\(|fbq\(|clarity\.ms/i.test(s.text)) {
        add("external-resource", "error", page, "計測タグらしきスクリプトがある");
      }
    }
    if (root.querySelector("form")) add("form-present", "error", page, "問い合わせフォーム（form要素）がある");

    // 要確認マーカー
    const body = root.querySelector("body") ?? root;
    const bodyText = body.textContent;
    const headText = (root.querySelector("head")?.toString() ?? "").replace(/<style[\s\S]*?<\/style>/g, "");
    const rawCount = [...bodyText.matchAll(markerRegex()), ...headText.matchAll(markerRegex())].length;
    const shown = root.querySelectorAll(`[${MARKER_ATTRIBUTE}]`);
    if (rawCount > 0) {
      add("unresolved-marker", "error", page, `要確認マーカーが文字列のまま ${rawCount} 件残っている`);
    }
    if (shown.length > 0) {
      const notes = shown.map((e) => e.getAttribute(MARKER_ATTRIBUTE) || "(説明なし)").join("、");
      if (mode === "demo") add("unresolved-marker", "warning", page, `要確認の表示が ${shown.length} 件（${notes}）`);
      else add("unresolved-marker", "error", page, `要確認の表示が ${shown.length} 件残っている（${notes}）`);
    }

    // デモ表示と noindex
    const notices = root.querySelectorAll("[data-demo-notice]");
    const robots = root.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "";
    const noindex = /noindex/i.test(robots);
    if (mode === "demo") {
      for (const where of ["top", "footer"]) {
        const el = notices.find((n) => n.getAttribute("data-demo-notice") === where);
        if (!el)
          add(
            "demo-notice-missing",
            "error",
            page,
            `非公式デモの表示（${where === "top" ? "ページ上部" : "フッター"}）がない`,
          );
        else if (!DEMO_NOTICE_PHRASES.every((p) => el.text.includes(p))) {
          add(
            "demo-notice-missing",
            "error",
            page,
            `非公式デモの表示（${where}）の文面に必要な語がない：${el.text.trim()}`,
          );
        }
      }
      if (!noindex) add("noindex-missing", "error", page, "demo なのに robots noindex がない");
    } else if (mode === "delivery") {
      if (notices.length > 0 || bodyText.includes("非公式の改善提案デモ")) {
        add("demo-notice-unexpected", "error", page, "delivery にデモ表示が残っている");
      }
      if (noindex) add("noindex-unexpected", "error", page, "delivery に noindex が残っている（検索に出なくなる）");
    }
  }

  let mobile: CheckReport["mobile"] = { status: "skipped" };
  if (opts.mobile && pages.length > 0) {
    mobile = await checkMobileLayout(dist, pages, opts.mobileOptions);
    if (mobile.status === "measured") {
      for (const r of mobile.results) {
        if (r.overflow) {
          add(
            "horizontal-overflow",
            "error",
            r.page,
            `幅 ${r.innerWidth}px で横スクロールが出る（scrollWidth ${r.scrollWidth}px）${r.offenders.length ? `：${r.offenders.join(", ")}` : ""}`,
          );
        }
      }
    }
  }

  const counts: CheckReport["counts"] = {};
  for (const i of issues) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  return { ok: !issues.some((i) => i.severity === "error"), distDir: dist, pages, issues, counts, mobile };
}

/** 人が読む形の報告。 */
export function formatReport(r: CheckReport): string {
  const lines = [`検査：${r.distDir}（${r.pages.length} ページ） → ${r.ok ? "OK" : "NG"}`];
  for (const i of r.issues) lines.push(`  [${i.severity}] ${i.kind} ${i.file}: ${i.detail}`);
  if (r.mobile.status === "skipped") lines.push("  スマホ幅：検査せず（--mobile で実行）");
  else if (r.mobile.status === "unavailable") lines.push(`  スマホ幅：未実施（${r.mobile.reason}）`);
  else {
    for (const m of r.mobile.results) {
      lines.push(
        `  スマホ幅：${m.page} 幅${m.innerWidth}px scrollWidth ${m.scrollWidth}px → ${m.overflow ? "横スクロールあり" : "OK"}`,
      );
    }
  }
  return lines.join("\n");
}

/** dist が存在するか（CLI用）。 */
export async function isDirectory(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false;
}
