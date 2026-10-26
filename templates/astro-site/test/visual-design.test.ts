import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, textColorOn } from "../lib/color.ts";
import { visualDesignStyle } from "../lib/visual-design.ts";
import {
  SiteGenerationOutputSchema,
  siteGenerationToSiteInput,
  siteInputToSiteGeneration,
} from "../schema/site-generation.ts";
import { SiteInputSchema } from "../schema/site-input.ts";
import { type VisualDesign, VisualDesignSchema } from "../schema/visual-design.ts";

export const referenceVisual: VisualDesign = {
  headingFont: "serif",
  bodyFont: "sans",
  headingScale: "expressive",
  background: "#f7f5ef",
  surface: "#ffffff",
  text: "#20362b",
  headerTone: "surface",
  buttonTone: "brand",
  spacing: "spacious",
  corners: "square",
  contentWidth: "wide",
  heroTextShare: 40,
  heroFrame: "edge-to-edge",
  heroImageRatio: "portrait",
  mobileHeroOrder: "image-first",
  serviceLayout: "list",
};
const fixture = () =>
  SiteGenerationOutputSchema.parse(
    JSON.parse(readFileSync(new URL("../../../fixtures/codex/demo_site.json", import.meta.url), "utf8")),
  );

describe("参照画像の独立した視覚設定", () => {
  it("明朝の見出しとゴシックの本文を共存させ、変換往復で保持する", () => {
    const out = fixture();
    out.theme.visual = referenceVisual;
    const input = siteGenerationToSiteInput(out);
    expect(input.theme.visual).toEqual(referenceVisual);
    expect(siteInputToSiteGeneration(input)).toEqual({ ok: true, output: out });
  });
  it("旧構成に視覚設定を自動追加せず、既存のプリセットを使う", () => {
    const old = fixture();
    const input = SiteInputSchema.parse(siteGenerationToSiteInput(old));
    expect(input.theme).not.toHaveProperty("visual");
    expect(visualDesignStyle(input.theme)).toBe("");
    expect(siteInputToSiteGeneration(input)).toEqual({ ok: true, output: old });
  });
  it.each([
    { background: "url(https://example.test/image)" },
    { background: "#fff;display:none" },
    { headingFont: '"Custom";background:red' },
    { headingFont: "https://example.test/font" },
    { heroTextShare: 34 },
    { heroTextShare: 66 },
    { heroTextShare: 45.5 },
    { text: "#eeeeee" },
    { surface: "#20362b" },
    { css: "display:none" },
  ])("CSS注入、範囲外、低コントラストの指定を拒否する %j", (change) => {
    expect(VisualDesignSchema.safeParse({ ...referenceVisual, ...change }).success).toBe(false);
  });
  it("明朝・直角・広い余白・非対称の分割を有限のCSS変数で出す", () => {
    const theme = { ...fixture().theme, style: "warm" as const, visual: referenceVisual };
    const style = visualDesignStyle(theme);
    expect(style).toContain('--visual-heading-font:"Yu Mincho"');
    expect(style).toContain("--visual-body-font:system-ui");
    expect(style).toContain("--visual-radius:0px;");
    expect(style).toContain("--visual-section-space:88px;");
    expect(style).toContain("--visual-hero-columns:minmax(0, 40fr) minmax(0, 60fr);");
    expect(style).toContain(`--visual-button:${theme.brand};`);
    expect(style).not.toContain("undefined");
  });
  it("中間の明るさを含むボタン・帯の文字色が4.5以上のコントラストを確保する", () => {
    for (let r = 0; r <= 255; r += 17)
      for (let g = 0; g <= 255; g += 17)
        for (let b = 0; b <= 255; b += 17) {
          const color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
          expect(contrastRatio(color, textColorOn(color))).toBeGreaterThanOrEqual(4.5);
        }
  });
});
