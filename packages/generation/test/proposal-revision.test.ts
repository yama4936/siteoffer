import { expect, it } from "vitest";
import { buildPrompt } from "../src/prompt.ts";
import { fixtureInput } from "./helpers.ts";

it("運営の修正がある生成だけに版付きの指示を加え、事実と作業範囲を維持する", () => {
  const input = fixtureInput();
  input.context.proposalRevision = { sourceVersionId: "fixture-source-version", request: "見出しを短くしてください。" };
  for (const purpose of ["proposal_text", "call_script", "faq", "demo_site"] as const) {
    const prompt = buildPrompt(purpose, input);
    expect(prompt.version).toMatch(/\+proposal_revision\.v1#[a-f0-9]{8}$/);
    expect(prompt.text).toContain("confirmed にない情報は採用しない");
    expect(prompt.text).toContain("秘密情報の取得");
    expect(prompt.text).toContain("見出しを短くしてください。");
    expect(buildPrompt(purpose, fixtureInput()).version).not.toContain("proposal_revision");
  }
});
it("人の修正メモと機械の検査結果を別の版として同じ試行へ渡す", () => {
  const input = fixtureInput();
  input.context.proposalRevision = { sourceVersionId: "fixture-source-version", request: "電話を間違えないでください" };
  const prompt = buildPrompt("demo_site", input, {
    error: "fact_violation",
    rules: ["identity_mismatch"],
    fields: ["contact.email"],
  });
  expect(prompt.version).toMatch(/\+proposal_revision\.v1#[a-f0-9]{8}\+validation_retry\.v1#[a-f0-9]{8}$/);
  expect(prompt.text).toContain('"contact.email"');
  expect(prompt.text).toContain("電話を間違えないでください");
});
