/**
 * 生成（Codex。用途 demo_site）の固定応答 fixtures/codex/demo_site.json を、テンプレート入力に変換して実際にビルドする（1回だけ）。
 * あわせて、テンプレート入力 ⇔ 生成の出力の変換を確かめる。
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BuildSiteResult, buildSite } from "../build/build-site.ts";
import { checkDist } from "../check/check-dist.ts";
import { findMarkers, formatMarker, markerRegex } from "../lib/markers.ts";
import { validateSiteInput } from "../lib/resolve.ts";
import {
  SiteGenerationOutputSchema,
  siteGenerationToSiteInput,
  siteInputToSiteGeneration,
} from "../schema/site-generation.ts";

const BUILD_TIMEOUT = 240_000;
const codexFixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/codex/${name}.json`, import.meta.url)), "utf8"));
const templateFixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}/site.json`, import.meta.url)), "utf8"));

let work: string;
let demo: BuildSiteResult;

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "siteoffer-astro-gen-"));
  const out = SiteGenerationOutputSchema.parse(codexFixture("demo_site"));
  const inputPath = path.join(work, "site.json");
  await writeFile(inputPath, JSON.stringify(siteGenerationToSiteInput(out), null, 2));
  demo = await buildSite({ inputPath, outDir: path.join(work, "dist"), mode: "demo", env: {} });
}, BUILD_TIMEOUT);

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

describe("生成の固定応答をテンプレートでビルドする", () => {
  it("demo_site の固定応答は demo でビルドでき、検査に通る", async () => {
    if (!demo.ok) throw new Error(`ビルド失敗：${demo.reason} ${demo.message}\n${demo.log ?? ""}`);
    expect(demo.mode).toBe("demo");
    expect(demo.markers).toEqual([]);
    const report = await checkDist(demo.outDir, { mode: "demo" });
    expect(report.issues).toEqual([]);
    const page = await readFile(path.join(demo.outDir, "index.html"), "utf8");
    expect(page).toContain("株式会社あおば工務店");
    expect(page).toContain("年間120件（2025年度、社内集計）");
    // factRef は来歴であり、ページには出さない
    expect(page).not.toContain("achievement.yearly");
  });

  it("delivery_site の固定応答はテンプレート入力として有効で、要確認マーカーがない（delivery のビルド条件）", () => {
    const out = SiteGenerationOutputSchema.parse(codexFixture("delivery_site"));
    const v = validateSiteInput(siteGenerationToSiteInput(out, { mode: "delivery" }));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.input.mode).toBe("delivery");
      expect(v.markers).toEqual([]);
    }
  });
});

describe("テンプレート入力 → 生成の出力の形", () => {
  it("factRef のない会社情報・実績は根拠を辿れないので変換しない", () => {
    const r = siteInputToSiteGeneration(templateFixture("full"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith("companyInfo.rows.0"))).toBe(true);
  });

  it("factRef があれば変換でき、画像など生成に任せない項目は落ちる", () => {
    const raw = templateFixture("full") as {
      companyInfo: { rows: Array<{ factRef?: string }> };
      works: { items: Array<{ factRef?: string }> };
    };
    raw.companyInfo.rows.forEach((r, i) => {
      r.factRef = `row.${i}`;
    });
    raw.works.items.forEach((w, i) => {
      w.factRef = `work.${i}`;
    });
    const r = siteInputToSiteGeneration(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(SiteGenerationOutputSchema.safeParse(r.output).success).toBe(true);
    expect(JSON.stringify(r.output)).not.toContain("images/");
  });
});

describe("要確認マーカーの表記", () => {
  it("formatMarker の出力はテンプレートの検出に一致する", () => {
    expect(formatMarker("施工件数")).toBe("{{要確認:施工件数}}");
    expect(formatMarker()).toBe("{{要確認}}");
    expect(formatMarker("a}b")).toBe("{{要確認:ab}}");
    expect(findMarkers({ x: `年間${formatMarker("件数")}件` })).toEqual([{ path: "x", note: "件数" }]);
    expect(markerRegex().test(formatMarker())).toBe(true);
  });
});
