import { z } from "zod";
import { contrastRatio } from "../lib/color.ts";

const color = z.string().regex(/^#[a-fA-F0-9]{6}$/, "色は #RRGGBB で指定してください");
/** Independent design axes. No arbitrary CSS, font URLs, scripts, or image paths. */
export const VisualDesignSchema = z
  .strictObject({
    headingFont: z.enum(["serif", "sans"]),
    bodyFont: z.enum(["serif", "sans"]),
    headingScale: z.enum(["standard", "expressive"]),
    background: color,
    surface: color,
    text: color,
    headerTone: z.enum(["surface", "brand"]),
    buttonTone: z.enum(["brand", "accent"]),
    spacing: z.enum(["compact", "comfortable", "spacious"]),
    corners: z.enum(["square", "soft", "round"]),
    contentWidth: z.enum(["standard", "wide"]),
    heroTextShare: z.number().int().min(35).max(65),
    heroFrame: z.enum(["contained", "edge-to-edge"]),
    heroImageRatio: z.enum(["landscape", "square", "portrait"]),
    mobileHeroOrder: z.enum(["image-first", "text-first"]),
    serviceLayout: z.enum(["list", "grid"]),
  })
  .superRefine((visual, context) => {
    if (contrastRatio(visual.text, visual.background) < 4.5 || contrastRatio(visual.text, visual.surface) < 4.5)
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "本文の文字色と背景・面のコントラストは4.5以上にしてください",
      });
  });
export type VisualDesign = z.infer<typeof VisualDesignSchema>;
