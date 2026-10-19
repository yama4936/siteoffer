import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { checkFacts } from "../src/facts.ts";
import { loadCodexFixture } from "../src/mock.ts";
import { generationOutputSchemas } from "../src/schemas.ts";
import { validateOutput } from "../src/validate.ts";
import { clone, fixtureInput } from "./helpers.ts";

function numericInput(support: string[]) {
  const input = fixtureInput();
  input.facts = support.map((value, i) => ({
    key: `fixture.${i}`,
    label: "架空の根拠",
    value,
    status: "confirmed" as const,
    source: "numeric fixture",
  }));
  input.externalData = [];
  input.context = {};
  return input;
}

describe("数値の主張は根拠内の別の数字の一部分で裏付けない", () => {
  it.each([
    { support: [], claim: "年間５００件に対応します。" },
    { support: ["料金1500円"], claim: "料金500円です。" },
    { support: ["年間120件"], claim: "年間20件です。" },
    { support: ["割合20%"], claim: "割合0%です。" },
    { support: ["2", "50件"], claim: "250件です。" },
    { support: ["No.10"], claim: "No.1です。" },
    { support: ["11位"], claim: "1位です。" },
    { support: ["1.2万件"], claim: "2万件です。" },
    { support: ["-30%"], claim: "30%です。" },
    { support: ["1.5年以上"], claim: "5年以上です。" },
  ])("根拠 $support から $claim を採用しない", ({ support, claim }) => {
    expect(checkFacts("proposal_text", numericInput(support), { summary: claim })).toContainEqual({
      kind: "unsupported_claim",
      path: "summary",
      detail: expect.any(String),
    });
  });

  it.each([
    { support: ["割合１．５％"], claim: "割合1.5%です。" },
    { support: ["年間1,200件"], claim: "年間１２００件です。" },
    { support: ["創業１９９８年"], claim: "創業1998年です。" },
    { support: ["Ｎｏ．１"], claim: "No.1です。" },
    { support: ["料金３，５００円"], claim: "料金3500円です。" },
    { support: ["−２．５％"], claim: "-2.5%です。" },
    { support: ["￥３，５００"], claim: "¥3500です。" },
    { support: ["年間１．２万件"], claim: "年間1.2万件です。" },
  ])("同じ数量の表記違いは認める: $support / $claim", ({ support, claim }) => {
    expect(checkFacts("proposal_text", numericInput(support), { summary: claim })).toEqual([]);
  });

  it("別単位、未確認値、別の小数の末尾を根拠にしない", () => {
    const input = numericInput(["120件", "割合10.5%"]);
    input.facts.push({ key: "pending", label: "未確認", value: "500件", status: "needs_review", source: "fixture" });
    const issues = checkFacts("proposal_text", input, { summary: "120社、500件、0.5%です。" });
    expect(issues.filter((v) => v.kind === "unsupported_claim")).toHaveLength(3);
    expect(issues.some((v) => v.kind === "needs_review_value")).toBe(true);
  });

  it("取得済み観測と提案条件の数値は維持し、元の入力を変えない", () => {
    const input = numericInput([]);
    input.externalData = [
      { id: "observation", sourceUrl: null, fetchedAt: null, content: "取得したページには１２０件と記載。" },
    ];
    input.context = { terms: "月額5,000円" };
    const before = structuredClone(input);
    expect(checkFacts("proposal_text", input, { summary: "現状には120件とあり、月額５０００円です。" })).toEqual([]);
    expect(input).toEqual(before);
  });
});

it.each([
  { purpose: "proposal_text", field: "summary" },
  { purpose: "call_script", field: "opening" },
  { purpose: "faq", field: "items.0.answer" },
  { purpose: "demo_site", field: "hero.lead" },
] as const)("$purpose の通常の出力検査でも全角の無根拠な実績を拒否する", ({ purpose, field }) => {
  const output = clone(loadCodexFixture(purpose)) as Record<string, unknown>;
  if (purpose === "faq") (output.items as { answer: string }[])[0]!.answer = "年間５００件の施工を行います。";
  else if (purpose === "demo_site") (output.hero as { lead: string }).lead = "年間５００件の施工を行います。";
  else output[field] = "年間５００件の施工を行います。";
  const result = validateOutput(
    purpose,
    fixtureInput(),
    generationOutputSchemas[purpose] as z.ZodType<unknown>,
    output,
  );
  expect(result).toMatchObject({ ok: false, error: "fact_violation", feedback: { rules: ["unsupported_claim"] } });
});
