import { expect, it } from "vitest";
import {
  historyActionLabel,
  historyFields,
  historyMatchingActions,
  historyTargetLink,
  historyValue,
} from "./history-presentation";
import { historyDate, historyHref, historyParams, parseHistoryQuery } from "./history-query";

it("date ranges are strict calendar dates in Japan time and round-trip every filter", () => {
  const query = parseHistoryQuery({
    q: "企業%_",
    actor: "ops",
    action: "discovery.",
    targetType: "company",
    targetId: "record",
    from: "2024-02-29",
    to: "2024-03-01",
    page: "2",
  })!;
  expect(historyDate(query.from)?.toISOString()).toBe("2024-02-28T15:00:00.000Z");
  expect(parseHistoryQuery(Object.fromEntries(historyParams(query)))).toEqual(query);
  expect(historyHref(query, { page: 3 })).toContain("page=3");
  expect(historyHref(parseHistoryQuery({})!)).toBe("/ops/history");
});
it.each([
  { from: "0000-01-01" },
  { from: "2026-02-29" },
  { from: "2026-13-01" },
  { to: "2026-04-31" },
  { from: "2026-10-19", to: "2026-10-18" },
  { page: "0" },
  { page: "1.5" },
  { page: "2147483648" },
  { page: "9007199254740993" },
  { actor: "__proto__" },
  { q: ["one", "two"] },
  { q: "x\n" },
  { q: "x".repeat(121) },
  { targetId: "x".repeat(301) },
])("rejects ambiguous or invalid filters %j", (input) => {
  expect(parseHistoryQuery(input)).toBeNull();
});
it("action labels and record links preserve unknown operations without inventing outcomes", () => {
  expect(historyActionLabel("proposal_version.approve")).toBe("提案を承認");
  expect(historyMatchingActions("公式サイト")).toContain("company.website_candidate_saved");
  expect(historyActionLabel("__proto__")).toBe("記録された操作");
  expect(historyActionLabel("constructor.unknown")).toBe("記録された操作");
  expect(historyTargetLink("company", "11111111-1111-4111-8111-111111111111", "架空企業")).toContain("/ops/companies/");
  expect(historyTargetLink("company", "javascript:alert(1)", "x")).toBeNull();
  expect(historyTargetLink("company", "11111111-1111-4111-8111-111111111111", null)).toBeNull();
});
it("bounded text presentation removes credential fields and credential URLs without changing stored values", () => {
  const secret = "test-only-hidden-value";
  const input = {
    name: "公開情報",
    api_key: secret,
    nested: { passwordHash: secret, url: `https://example.test/?access_token=${secret}` },
    auth: `Bearer ${secret}`,
    items: Array.from({ length: 40 }, (_, i) => i),
    long: "x".repeat(3000),
  };
  const output = historyValue(input);
  expect(JSON.stringify(output)).not.toContain(secret);
  expect(JSON.stringify(output)).toContain("表示を省略");
  expect(input.api_key).toBe(secret);
  expect(input.items).toHaveLength(40);
  expect(historyValue(`https://example.test/?X-Amz-Signature=${secret}`)).not.toContain(secret);
  expect(historyFields({ key: "assignment.maxActive" }, { key: "assignment.maxActive" }).items[0]?.after).toBe(
    "assignment.maxActive",
  );
});
it("prototype-like keys, deeply nested values and excess fields remain safe and explicitly bounded", () => {
  const input = JSON.parse('{"__proto__":{"token":"private"},"constructor":"safe","表示の省略":"original"}');
  Object.assign(input, Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, i])));
  const fields = historyFields(input, {
    ...input,
    nested: { one: { two: { three: { four: { five: "DEEP_VALUE" } } } } },
  });
  expect(fields.items[0]?.label).toBe("__proto__");
  expect(fields.items).toHaveLength(30);
  expect(fields.omitted).toBeGreaterThan(0);
  expect(JSON.stringify(historyValue(input))).not.toContain("private");
  expect(JSON.stringify(historyValue({ one: { two: { three: { four: { five: "DEEP_VALUE" } } } } }))).not.toContain(
    "DEEP_VALUE",
  );
  expect(({} as { token?: string }).token).toBeUndefined();
});
