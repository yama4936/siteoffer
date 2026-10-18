import { z } from "zod";
import { SiteModeSchema } from "../schema/site-input.ts";

export const SITE_BUILD_REQUEST = "build-request.json";
export const SITE_BUILD_RESULT = "build-result.json";
export const siteBuildRequestSchema = z.strictObject({
  executionId: z.string().uuid(),
  mode: SiteModeSchema,
  timeoutMs: z.number().int().min(1000).max(900_000),
});
export const siteBuildCheckSchema = z.strictObject({
  ok: z.boolean(),
  pages: z.array(z.string().max(512)).max(100),
  counts: z.record(z.string().max(100), z.number().int().nonnegative()),
  errors: z
    .array(z.strictObject({ kind: z.string().max(100), file: z.string().max(512), detail: z.string().max(1000) }))
    .max(20),
  mobile: z.literal("skipped"),
});
export const siteBuildResultSchema = z.strictObject({
  executionId: z.string().uuid(),
  ok: z.boolean(),
  reason: z
    .enum([
      "invalid-input",
      "unresolved-markers",
      "missing-image",
      "unsafe-out-dir",
      "astro-build-failed",
      "check-failed",
      "internal-error",
    ])
    .nullable(),
  check: siteBuildCheckSchema.nullable(),
});
export type SiteBuildReceipt = z.infer<typeof siteBuildResultSchema>;
