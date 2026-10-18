import { z } from "zod";

/**
 * ZodスキーマをCodexの outputSchema（JSON Schemaのプレーンなオブジェクト）に変換する。
 * SDKのREADMEは「プレーンなJSONオブジェクトを渡す」とだけ記載している。
 * OpenAIの構造化出力の厳格モードは oneOf を受け付けないため anyOf に置き換える
 * （Codex CLIが厳格モードを使うかどうかは未確認）。
 * superRefine等の検査はJSON Schemaに表れないため、応答は必ずZodで再検証する。
 */
export function toCodexOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return replaceOneOf(json) as Record<string, unknown>;
}

function replaceOneOf(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(replaceOneOf);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v)) out[k === "oneOf" ? "anyOf" : k] = replaceOneOf(child);
    // Parsers accept absent additive fields in saved legacy records; strict model responses explicitly return every key.
    if (out.type === "object" && out.properties && typeof out.properties === "object")
      out.required = Object.keys(out.properties);
    return out;
  }
  return v;
}
