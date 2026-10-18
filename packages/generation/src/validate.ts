import type { z } from "zod";
import { referenceVisualValid, requiresReferenceVisual } from "./design-reference.ts";
import { checkFacts } from "./facts.ts";
import type { GenerationInput, GenerationPurpose } from "./schemas.ts";
import type { GeneratorErrorCode } from "./types.ts";

export type ValidationResult<T> =
  | { ok: true; output: T }
  | {
      ok: false;
      error: Extract<GeneratorErrorCode, "empty_response" | "invalid_json" | "schema_violation" | "fact_violation">;
      message: string;
    };

/** 生成の生の応答（JSON文字列）を、JSON解析→Zod検証→事実検査の順に通す */
export function validateRawOutput<T>(
  purpose: GenerationPurpose,
  input: GenerationInput,
  schema: z.ZodType<T>,
  raw: string | null,
): ValidationResult<T> {
  if (raw === null || raw.trim() === "") return { ok: false, error: "empty_response", message: "応答が空" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: "invalid_json", message: `JSONとして解析できない: ${(e as Error).message}` };
  }
  return validateOutput(purpose, input, schema, parsed);
}

export function validateOutput<T>(
  purpose: GenerationPurpose,
  input: GenerationInput,
  schema: z.ZodType<T>,
  value: unknown,
): ValidationResult<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: "schema_violation", message: issues };
  }
  if (requiresReferenceVisual(purpose, input) && !referenceVisualValid(parsed.data, input))
    return {
      ok: false,
      error: "schema_violation",
      message: "承認画像に基づく書体・配色・余白・構成が未指定、または参照画像の配色候補と一致しません",
    };
  const violations = checkFacts(purpose, input, parsed.data);
  if (violations.length > 0) {
    const msg = violations
      .slice(0, 10)
      .map((v) => `${v.path}: ${v.detail}`)
      .join("; ");
    return { ok: false, error: "fact_violation", message: msg };
  }
  return { ok: true, output: parsed.data };
}
