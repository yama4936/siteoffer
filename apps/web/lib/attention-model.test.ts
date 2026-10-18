import { expect, it } from "vitest";
import { type AttentionSummary, parseAttentionSummary } from "./attention-model";

function fixture(): AttentionSummary {
  return {
    role: "ops",
    checkedAt: "2026-10-18T00:00:00Z",
    total: 1,
    groups: [{ key: "design", label: "デザイン", count: 1, href: "/ops?group=design" }],
    items: [
      {
        key: "design:1",
        title: "架空企業",
        reason: "画像を確認",
        action: "開く",
        href: "/ops/designs?focus=1",
        group: "design",
      },
    ],
  };
}
it("accepts empty and complete summaries for the matching workspace only", () => {
  expect(parseAttentionSummary(fixture(), "ops")).toEqual(fixture());
  expect(parseAttentionSummary(fixture(), "sales")).toBeNull();
  expect(
    parseAttentionSummary(
      { role: "sales", total: 0, checkedAt: "2026-10-18T00:00:00Z", groups: [], items: [] },
      "sales",
    ),
  ).not.toBeNull();
});
it("rejects external, cross-role, traversal and control-character links", () => {
  for (const href of [
    "https://example.test/ops",
    "//example.test/ops",
    "javascript:alert(1)",
    "/sales/assignments",
    "/ops/../account/security",
    "/ops\\..\\account",
    "/ops\u0000/invalid",
  ]) {
    const value = fixture();
    value.items[0]!.href = href;
    expect(parseAttentionSummary(value, "ops")).toBeNull();
  }
});
it("rejects incorrect counts, oversized responses, duplicate keys and broken dates", () => {
  const checks: unknown[] = [
    null,
    [],
    { ...fixture(), checkedAt: "invalid" },
    { ...fixture(), total: -1 },
    { ...fixture(), total: 2 },
    { ...fixture(), items: Array(7).fill(fixture().items[0]) },
    { ...fixture(), groups: [...fixture().groups, ...fixture().groups] },
    { ...fixture(), items: [{ ...fixture().items[0], group: "unknown" }] },
    { ...fixture(), items: [{ ...fixture().items[0], reason: "x".repeat(1001) }] },
  ];
  for (const value of checks) expect(parseAttentionSummary(value, "ops")).toBeNull();
  const duplicated = fixture();
  duplicated.total = 2;
  duplicated.groups[0]!.count = 2;
  duplicated.items.push(duplicated.items[0]!);
  expect(parseAttentionSummary(duplicated, "ops")).toBeNull();
});
