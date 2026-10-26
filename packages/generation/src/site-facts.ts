import type { FactViolation } from "./facts.ts";
import type { Fact, GenerationInput } from "./schemas.ts";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const textValue = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
function phoneValue(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[‐‑‒–—―−ー]/gu, "-")
    .trim();
  return /^\+?[0-9()\s-]+$/.test(normalized) ? normalized.replace(/[()\s-]/gu, "") : null;
}
function emailValue(value: string) {
  const normalized = value.trim(),
    at = normalized.lastIndexOf("@");
  return at > 0 ? normalized.slice(0, at) + normalized.slice(at).toLowerCase() : null;
}
function normalized(key: string, value: string) {
  return key === "company.phone" ? phoneValue(value) : key === "company.email" ? emailValue(value) : textValue(value);
}
function shortCompanyName(name: string) {
  // Only legal-form removal is inferred; a different trade name needs its own confirmed fact.
  const legal = "株式会社|有限会社|合同会社|合資会社|合名会社|\\(株\\)|\\(有\\)|\\(同\\)";
  return textValue(name).replace(new RegExp(`^(?:${legal})|(?:${legal})$`, "gu"), "");
}

/** Exact identity/contact values are not prose to paraphrase, even when factRef exists. */
export function checkSiteFacts(input: GenerationInput, output: unknown): FactViolation[] {
  const violations: FactViolation[] = [];
  const facts = new Map<string, Fact[]>();
  for (const fact of input.facts) facts.set(fact.key, [...(facts.get(fact.key) ?? []), fact]);
  const confirmed = (key: string) => {
    const entries = facts.get(key);
    return entries?.length === 1 && entries[0]?.status === "confirmed" ? entries[0] : null;
  };
  function match(key: string, value: unknown, path: string, kind: FactViolation["kind"]) {
    const fact = confirmed(key);
    const actual = typeof value === "string" ? normalized(key, value) : null;
    const expected = fact ? normalized(key, fact.value) : null;
    if (!actual || !expected || actual !== expected)
      violations.push({ kind, path, detail: `確認済みの「${fact?.label ?? key}」と掲載値が一致しません` });
  }
  const site = object(output),
    company = object(site.company),
    contact = object(site.contact);
  match("company.name", company.name, "company.name", "identity_mismatch");
  if (company.shortName !== null && company.shortName !== undefined) {
    const name = confirmed("company.name"),
      alias = confirmed("company.shortName");
    const candidates = [name?.value, name ? shortCompanyName(name.value) : null, alias?.value]
      .filter((v): v is string => !!v)
      .map(textValue);
    if (typeof company.shortName !== "string" || !candidates.includes(textValue(company.shortName)))
      violations.push({
        kind: "identity_mismatch",
        path: "company.shortName",
        detail: "屋号・略称は正式名称の法人格を省いた表記か、確認済みの屋号を使ってください",
      });
  }
  const phone = object(contact.phone);
  if (contact.phone !== null && contact.phone !== undefined) {
    match("company.phone", phone.display, "contact.phone.display", "identity_mismatch");
    if (phone.tel !== null && phone.tel !== undefined)
      match("company.phone", phone.tel, "contact.phone.tel", "identity_mismatch");
  }
  for (const [field, key] of [
    ["email", "company.email"],
    ["hours", "company.hours"],
  ] as const)
    if (contact[field] !== null && contact[field] !== undefined)
      match(key, contact[field], `contact.${field}`, "identity_mismatch");
  const rows = object(site.companyInfo).rows;
  if (Array.isArray(rows))
    for (const [index, item] of rows.entries()) {
      const row = object(item);
      // Missing/unconfirmed keys are handled by the existing factRef validator.
      if (
        typeof row.factRef === "string" &&
        facts.has(row.factRef) &&
        facts.get(row.factRef)!.some((f) => f.status === "confirmed")
      )
        match(row.factRef, row.value, `companyInfo.rows.${index}.value`, "fact_value_mismatch");
    }
  return violations;
}
