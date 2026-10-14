import type { z } from "zod";
import type { GenerationPurpose } from "./input.ts";
import { callScriptSchema, evaluationSchema, faqSchema, proposalTextSchema, siteConfigSchema } from "./outputs.ts";

export * from "./input.ts";
export * from "./outputs.ts";

/** 用途ごとの既定の出力スキーマ */
export const generationOutputSchemas = {
  evaluation: evaluationSchema,
  proposal_text: proposalTextSchema,
  call_script: callScriptSchema,
  faq: faqSchema,
  demo_site: siteConfigSchema,
  delivery_site: siteConfigSchema,
} as const satisfies Record<GenerationPurpose, z.ZodType>;

export type GenerationOutputOf<P extends GenerationPurpose> = z.infer<(typeof generationOutputSchemas)[P]>;
