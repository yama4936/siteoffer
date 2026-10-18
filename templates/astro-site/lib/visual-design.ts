import type { SiteInput } from "../schema/site-input.ts";
import { textColorOn } from "./color.ts";

export const VISUAL_FONTS = {
  serif: '"Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP", serif',
  sans: 'system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", Meiryo, sans-serif',
} as const;
/** Return only validated, finite CSS variables from the closed visual-design vocabulary. */
export function visualDesignStyle(theme: SiteInput["theme"]) {
  const visual = theme.visual;
  if (!visual) return "";
  const primary = visual.buttonTone === "brand" ? theme.brand : theme.accent;
  const header = visual.headerTone === "brand" ? theme.brand : visual.surface;
  const spacing = {
    compact: { section: 44, hero: 48, gap: 24 },
    comfortable: { section: 64, hero: 72, gap: 32 },
    spacious: { section: 88, hero: 96, gap: 48 },
  }[visual.spacing];
  const properties = {
    "visual-heading-font": VISUAL_FONTS[visual.headingFont],
    "visual-heading-size":
      visual.headingScale === "expressive" ? "clamp(2.4rem, 4.6vw, 4.2rem)" : "clamp(1.8rem, 3.6vw, 3rem)",
    "visual-body-font": VISUAL_FONTS[visual.bodyFont],
    "visual-background": visual.background,
    "visual-surface": visual.surface,
    "visual-text": visual.text,
    "visual-header": header,
    "visual-header-text": visual.headerTone === "brand" ? textColorOn(header) : visual.text,
    "visual-button": primary,
    "visual-button-text": textColorOn(primary),
    "visual-radius": `${{ square: 0, soft: 8, round: 20 }[visual.corners]}px`,
    "visual-width": `${visual.contentWidth === "wide" ? 1280 : 1080}px`,
    "visual-section-space": `${spacing.section}px`,
    "visual-hero-space": `${spacing.hero}px`,
    "visual-gap": `${spacing.gap}px`,
    "visual-hero-columns": `minmax(0, ${visual.heroTextShare}fr) minmax(0, ${100 - visual.heroTextShare}fr)`,
    "visual-image-ratio": { landscape: "4 / 3", square: "1", portrait: "4 / 5" }[visual.heroImageRatio],
  };
  return Object.entries(properties)
    .map(([key, value]) => `--${key}:${value};`)
    .join("");
}
