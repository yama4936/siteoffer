export type ValidationError = "empty_response" | "invalid_json" | "schema_violation" | "fact_violation";
const rules = {
  empty_response: ["empty_response"],
  invalid_json: ["invalid_json"],
  schema_violation: ["schema_violation", "reference_visual"],
  fact_violation: [
    "fact_violation",
    "marker",
    "needs_review_value",
    "unsupported_claim",
    "unknown_fact_ref",
    "unconfirmed_fact_ref",
    "identity_mismatch",
    "fact_value_mismatch",
  ],
} as const;
export type GenerationFeedback = {
  error: ValidationError;
  rules: string[];
  fields: string[];
};
const fieldPath =
  /^(?:company\.(?:name|shortName)|contact\.(?:email|hours|phone\.(?:display|tel))|companyInfo\.rows\.\d{1,4}\.value|theme\.visual)$/;

/** Never send provider messages, rejected output or arbitrary candidate keys back as instructions. */
export function sanitizeFeedback(value: unknown): GenerationFeedback | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (typeof data.error !== "string" || !Object.hasOwn(rules, data.error)) return;
  const error = data.error as ValidationError;
  const allowed: readonly string[] = rules[error];
  const codes = Array.isArray(data.rules)
    ? data.rules.slice(0, 32).filter((r): r is string => typeof r === "string" && allowed.includes(r))
    : [];
  const fields = Array.isArray(data.fields)
    ? data.fields.slice(0, 32).filter((f): f is string => typeof f === "string" && f.length <= 80 && fieldPath.test(f))
    : [];
  return {
    error,
    rules: [...new Set(codes.length ? codes : [error])].slice(0, 10),
    fields: [...new Set(fields)].slice(0, 10),
  };
}

export function validationFeedback(
  error: ValidationError,
  issues: { kind?: string; path?: string }[] = [],
): GenerationFeedback {
  return sanitizeFeedback({ error, rules: issues.map((i) => i.kind), fields: issues.map((i) => i.path) })!;
}
