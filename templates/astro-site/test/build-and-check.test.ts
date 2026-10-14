/**
 * フィクスチャを実際に Astro でビルドし、dist の検査を確かめる。
 * ビルドは重いので各フィクスチャ1回だけ（beforeAll）にし、欠陥の検出はビルド済み dist のコピーを壊して確かめる。
 * スマホ幅の計測（Chrome）は CHROME があるときだけ行う。
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BuildSiteResult, buildSite } from "../build/build-site.ts";
import { checkDist } from "../check/check-dist.ts";
import { findChrome } from "../check/mobile.ts";

const BUILD_TIMEOUT = 240_000;
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}/site.json`, import.meta.url));

let work: string;
let full: BuildSiteResult;
let noWorks: BuildSiteResult;
let needsConfirm: BuildSiteResult;

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "siteoffer-astro-test-"));
  // 直列に実行する（同時ビルドはメモリを多く使う）
  full = await buildSite({ inputPath: fixture("full"), outDir: path.join(work, "full"), env: {} });
  noWorks = await buildSite({ inputPath: fixture("no-works"), outDir: path.join(work, "no-works"), env: {} });
  needsConfirm = await buildSite({
    inputPath: fixture("needs-confirm"),
    outDir: path.join(work, "needs-confirm"),
    mode: "demo",
    env: {},
  });
}, BUILD_TIMEOUT * 3);

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

function expectOk(r: BuildSiteResult): asserts r is Extract<BuildSiteResult, { ok: true }> {
  if (!r.ok) throw new Error(`ビルド失敗：${r.reason} ${r.message}\n${r.log ?? ""}`);
}

const html = (r: BuildSiteResult) => {
  expectOk(r);
  return readFile(path.join(r.outDir, "index.html"), "utf8");
};

describe("ビルド", () => {
  it("要素が揃った例は demo でビルドでき、検査に通る", async () => {
    expectOk(full);
    expect(full.mode).toBe("demo");
    const report = await checkDist(full.outDir, { mode: "demo" });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("demo にはページ上部とフッターの非公式表示と noindex が入る", async () => {
    const page = await html(full);
    const notice =
      "これは株式会社ダミー住環境工房（架空）様向けの非公式の改善提案デモです。正式なサイトではありません。";
    expect(page).toContain(`data-demo-notice="top">${notice}`);
    expect(page).toContain(`data-demo-notice="footer">${notice}`);
    expect(page).toMatch(/<meta name="robots" content="noindex/);
    expect(page).toContain('name="viewport"');
    expect(page).toContain('data-style="warm"');
    expect(page).toContain('data-hero-layout="split"');
    expect(page).toContain('data-section-rhythm="alternating"');
    // 外部の読み込み・フォームがない
    expect(page).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(page).not.toContain("<form");
  });

  it("実績なしの例は delivery（入力JSONの mode）でビルドでき、非公式表示も実績セクションも出ない", async () => {
    expectOk(noWorks);
    expect(noWorks.mode).toBe("delivery");
    const page = await html(noWorks);
    expect(page).not.toContain("data-demo-notice");
    expect(page).not.toContain("noindex");
    expect(page).not.toContain('id="works"');
    // 構成の順序：取り扱い → お問い合わせ → お店について
    const order = ["services", "contact", "company"].map((id) => page.indexOf(`<section id="${id}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 色の差し替え
    expect(page).toContain("--brand:#3b2a20");
    const report = await checkDist(noWorks.outDir, { mode: "delivery" });
    expect(report.issues).toEqual([]);
  });

  it("要確認の残る例は demo の営業用画面から隠し、運営向けのビルド結果に残す", async () => {
    expectOk(needsConfirm);
    expect(needsConfirm.markers).toHaveLength(5);
    const page = await html(needsConfirm);
    expect(page).not.toContain("要確認");
    expect(page).not.toContain("data-needs-confirm");
    expect(page).not.toContain("{{要確認");
    expect(page).not.toContain("試作1個から量産前の数百個まで対応します。");
    expect(page).not.toContain('id="works"');
    // 電話番号が未確認なら tel リンクにしない
    expect(page).not.toContain('href="tel:');
    const report = await checkDist(needsConfirm.outDir, { mode: "demo" });
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    // 同じ dist を delivery として検査するとエラー（デモ表示・noindex）
    const asDelivery = await checkDist(needsConfirm.outDir, { mode: "delivery" });
    expect(asDelivery.ok).toBe(false);
    expect(Object.keys(asDelivery.counts).sort()).toEqual(["demo-notice-unexpected", "noindex-unexpected"].sort());
  });

  it("要確認の残る例を delivery でビルドすると失敗する（引数・環境変数のどちらでも）", async () => {
    const byArg = await buildSite({
      inputPath: fixture("needs-confirm"),
      outDir: path.join(work, "nc-del"),
      mode: "delivery",
    });
    expect(byArg.ok).toBe(false);
    if (!byArg.ok) {
      expect(byArg.reason).toBe("unresolved-markers");
      expect(byArg.markers?.map((m) => m.note)).toContain("代表電話番号");
    }
    const byEnv = await buildSite({
      inputPath: fixture("needs-confirm"),
      outDir: path.join(work, "nc-del2"),
      env: { SITEOFFER_SITE_MODE: "delivery" },
    });
    expect(byEnv.ok).toBe(false);
    if (!byEnv.ok) expect(byEnv.reason).toBe("unresolved-markers");
  });

  it("入力の画像が見つからなければビルド前に失敗する", async () => {
    const dir = path.join(work, "missing-image-input");
    await cp(path.dirname(fixture("full")), dir, { recursive: true });
    await rm(path.join(dir, "images", "hero.svg"));
    const r = await buildSite({ inputPath: path.join(dir, "site.json"), outDir: path.join(work, "mi-out") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing-image");
  });
});

describe("検査が欠陥を検出する", () => {
  it("リンク切れ・アンカー切れ・画像欠落・alt欠落・viewport欠落・デモ表示欠落・外部読み込み・フォーム・生のマーカー", async () => {
    expectOk(full);
    const broken = path.join(work, "broken");
    await cp(full.outDir, broken, { recursive: true });
    await rm(path.join(broken, "images", "03-work-1.svg"));
    let page = await readFile(path.join(broken, "index.html"), "utf8");
    page = page
      .replace('href="#works"', 'href="#no-such-section"')
      .replace('<a href="#top">ページの先頭へ</a>', '<a href="/about/">会社案内</a><a href="tel:">電話</a>')
      .replace(/<img src="images\/02-hero.svg" alt="[^"]*"/, '<img src="images/02-hero.svg"')
      .replace(/<meta name="viewport"[^>]*>/, "")
      .replace(/<div class="demo-notice demo-notice-top"[^>]*>[^<]*<\/div>/, "")
      .replace("</head>", '<script src="https://www.googletagmanager.com/gtag/js?id=X"></script></head>')
      .replace("</main>", "<form><input name=q></form><p>{{要確認:営業時間}}</p></main>");
    await writeFile(path.join(broken, "index.html"), page);

    const report = await checkDist(broken, { mode: "demo" });
    expect(report.ok).toBe(false);
    const kinds = new Set(report.issues.filter((i) => i.severity === "error").map((i) => i.kind));
    for (const k of [
      "broken-anchor",
      "broken-link",
      "missing-image",
      "missing-alt",
      "missing-viewport",
      "demo-notice-missing",
      "external-resource",
      "form-present",
      "unresolved-marker",
    ] as const) {
      expect(kinds.has(k), k).toBe(true);
    }
    const details = report.issues.map((i) => i.detail).join("\n");
    expect(details).toContain("#no-such-section");
    expect(details).toContain("/about/");
    expect(details).toContain("03-work-1.svg");
    expect(details).toContain("ページ上部");
  });

  it.skipIf(!findChrome())(
    "スマホ幅（375px）で横スクロールを測る（Chrome があるときのみ）",
    async () => {
      expectOk(full);
      const report = await checkDist(full.outDir, { mode: "demo", mobile: true });
      expect(report.mobile.status).toBe("measured");
      if (report.mobile.status === "measured") {
        expect(report.mobile.results[0]?.innerWidth).toBe(375);
        expect(report.mobile.results[0]?.overflow).toBe(false);
      }

      // 幅の固定された要素を入れると横スクロールを検出する
      const wide = path.join(work, "wide");
      await cp(full.outDir, wide, { recursive: true });
      const p = path.join(wide, "index.html");
      await writeFile(p, (await readFile(p, "utf8")).replace("</main>", '<div style="width:900px">wide</div></main>'));
      const bad = await checkDist(wide, { mode: "demo", mobile: true });
      expect(bad.issues.some((i) => i.kind === "horizontal-overflow")).toBe(true);
    },
    120_000,
  );
});
