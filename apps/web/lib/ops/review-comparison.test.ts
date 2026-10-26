import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { proposalRevisionFingerprint } from "@siteoffer/core";
import type { proposalVersions } from "@siteoffer/db";
import type { CallScript, Faq, ProposalText, SiteGenerationOutput } from "@siteoffer/schemas";
import { expect, it } from "vitest";
import { comparisonInputBounded, proposalDisplayGroups, reviewContentSummary } from "./proposal-display-fields";
import { buildReviewComparison, reviewChangeExcerpt } from "./review-comparison";

const proposalId = randomUUID(),
  auditId = randomUUID();
const loadCodexFixture = (purpose: string) =>
  JSON.parse(readFileSync(new URL(`../../../../fixtures/codex/${purpose}.json`, import.meta.url), "utf8"));
function content() {
  return {
    demoSite: structuredClone(loadCodexFixture("demo_site")) as SiteGenerationOutput,
    proposalText: structuredClone(loadCodexFixture("proposal_text")) as ProposalText,
    callScript: structuredClone(loadCodexFixture("call_script")) as CallScript,
    faq: structuredClone(loadCodexFixture("faq")) as Faq,
    demoImageAssets: [] as unknown[],
  };
}
function version(n: number, c: unknown = content()): typeof proposalVersions.$inferSelect {
  return {
    id: randomUUID(),
    proposalId,
    auditId,
    version: n,
    status: "in_review",
    content: c,
    demoArtifactDir: "C:/PRIVATE_STORAGE_SENTINEL",
    generationJobId: randomUUID(),
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: "PRIVATE_REVIEW_SENTINEL",
    createdAt: new Date("2026-10-19T00:00:00Z"),
  };
}
it("順不同の履歴から直前の同じ提案だけを選び、保存内容が同じなら変更なしとする", () => {
  const old = version(1),
    closer = version(3),
    current = version(4),
    future = version(5);
  const foreign = { ...version(3), proposalId: randomUUID() };
  const result = buildReviewComparison(current, [future, foreign, old, current, closer]);
  expect(result).toMatchObject({
    status: "ready",
    sourceId: closer.id,
    sourceVersion: 3,
    basis: "previous",
    changed: 0,
  });
  if (result.status !== "ready") throw Error("comparison missing");
  expect(result.compared).toBeGreaterThan(40);
  expect(result.groups.every((g) => !g.unavailable)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_STORAGE_SENTINEL|PRIVATE_REVIEW_SENTINEL|generationJobId/);
});
it("サイト・提案・台本・FAQの変更を日本語の前後の値として返す", () => {
  const c = content();
  c.demoSite.hero.catchcopy = "相談しやすい住まいづくり";
  c.demoSite.theme.brand = "#11382b";
  c.proposalText.measures[0]!.improvement = "スマホの写真を先に置く";
  c.callScript.opening = "変更した名乗りと用件";
  c.faq.items[0]!.answer = "変更した回答";
  const result = buildReviewComparison(version(2, c), [version(1)]);
  if (result.status !== "ready") throw Error("comparison missing");
  expect(result.groups.find((g) => g.id === "site")?.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: "メイン見出し", after: c.demoSite.hero.catchcopy }),
      expect.objectContaining({ label: "メインの色", after: "#11382b" }),
    ]),
  );
  for (const group of ["proposal", "call", "faq"])
    expect(result.groups.find((g) => g.id === group)?.changes.length).toBeGreaterThan(0);
});
it("修正元の署名があるときは直前の版で代用せず、元の企業・診断・内容を照合する", () => {
  const source = { ...version(1), status: "rejected" as const };
  const c = {
    ...content(),
    proposalRevision: {
      sourceVersionId: source.id,
      sourceVersion: 1,
      sourceSha256: proposalRevisionFingerprint(source),
    },
  };
  const current = version(3, c),
    previous = version(2);
  expect(buildReviewComparison(current, [previous, source])).toMatchObject({
    status: "ready",
    basis: "revision",
    sourceId: source.id,
  });
  for (const bad of [
    { ...source, proposalId: randomUUID() },
    { ...source, auditId: randomUUID() },
    { ...source, reviewNote: "後から変えたメモ" },
    { ...source, version: 4 },
  ]) {
    expect(buildReviewComparison(current, [previous, bad])).toMatchObject({ status: "unavailable" });
  }
  expect(
    buildReviewComparison(version(3, { ...c, proposalRevision: { sourceVersionId: source.id } }), [source]),
  ).toMatchObject({ status: "unavailable" });
});
it("未保存・不正・大きすぎる資料を変更なしと断定せず、生データを返さない", () => {
  const source = version(1);
  const c = {
    ...content(),
    demoSite: { private: "PRIVATE_METADATA_SENTINEL" },
    callScript: null,
    proposalText: { summary: "x".repeat(262145) },
    faq: { items: Array(1001).fill({ question: "large" }) },
  };
  const result = buildReviewComparison(version(2, c), [source]);
  if (result.status !== "ready") throw Error("comparison missing");
  expect(result.groups.filter((g) => g.unavailable).map((g) => g.id)).toEqual(["site", "proposal", "call", "faq"]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_METADATA_SENTINEL");
  expect(comparisonInputBounded({ a: Array(1001).fill("x") })).toBe(false);
});
it("長文の末尾の変更を同じ先頭で隠さず、抜粋でも絵文字を壊さない", () => {
  const before = `${"あ".repeat(5000)}変更前`,
    after = `${"あ".repeat(5000)}変更後`;
  const result = reviewChangeExcerpt(before, after);
  expect(result).toMatchObject({ excerpted: true });
  expect(result.before).toContain("変更前");
  expect(result.after).toContain("変更後");
  expect(result.before.length).toBeLessThan(1100);
  const emoji = reviewChangeExcerpt(`${"😀".repeat(2000)}😀A`, `${"😀".repeat(2000)}😃A`);
  for (const text of [emoji.before, emoji.after])
    expect(text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});
it("同じ名前の写真でもファイル・使用条件の変更を検出し、画像IDやハッシュを表示しない", () => {
  const asset = {
    assetId: randomUUID(),
    slot: "hero",
    label: "架空の写真",
    sha256: "a".repeat(64),
    policyRevision: 1,
    policy: {
      sourceType: "operator_upload",
      sourceUrl: null,
      rightsStatus: "use_approved",
      allowedUses: ["sales_demo"],
      confirmedBy: randomUUID(),
      confirmedAt: "2026-10-19T00:00:00Z",
      note: null,
    },
  };
  const before = { ...content(), demoImageAssets: [asset], designSha256: "b".repeat(64) };
  const after = {
    ...content(),
    demoImageAssets: [{ ...asset, sha256: "c".repeat(64), policyRevision: 2 }],
    designSha256: "b".repeat(64),
  };
  const result = buildReviewComparison(version(2, after), [version(1, before)]);
  if (result.status !== "ready") throw Error("comparison missing");
  expect(result.groups.find((g) => g.id === "images")).toMatchObject({
    unavailable: false,
    changes: [
      expect.objectContaining({
        key: "assets",
        after: expect.stringContaining("画像ファイルまたは利用条件が変わりました"),
      }),
    ],
  });
  expect(JSON.stringify(result)).not.toContain(asset.assetId);
  expect(JSON.stringify(result)).not.toContain(asset.sha256);
  const policyOnly = buildReviewComparison(
    version(2, {
      ...before,
      demoImageAssets: [{ ...asset, policy: { ...asset.policy, note: "PRIVATE_POLICY_SENTINEL" } }],
    }),
    [version(1, before)],
  );
  if (policyOnly.status !== "ready") throw Error("comparison missing");
  expect(policyOnly.groups.find((g) => g.id === "images")?.changes).toHaveLength(1);
  expect(JSON.stringify(policyOnly)).not.toContain("PRIVATE_POLICY_SENTINEL");
});
it("比較元がない場合は明示し、異なる提案の履歴を比較しない", () => {
  expect(buildReviewComparison(version(1), [])).toMatchObject({ status: "unavailable" });
  expect(buildReviewComparison(version(2), [{ ...version(1), proposalId: randomUUID() }])).toMatchObject({
    status: "unavailable",
  });
});
it("全文用の投影は台本・FAQ・提案の末尾まで保ち、実行情報を含めない", () => {
  const c = content();
  c.faq.items[0]!.answer = `${"長い回答".repeat(1000)}ここが全文の末尾`;
  c.callScript.closing = "省略しない締めの言葉";
  c.proposalText.strengths = ["残す良い点を確認する"];
  const groups = proposalDisplayGroups({ ...c, privateExecution: "PRIVATE_EXECUTION_SENTINEL" });
  expect(groups.find((g) => g.id === "faq")?.fields[0]?.value).toContain("ここが全文の末尾");
  expect(groups.find((g) => g.id === "call")?.fields.find((f) => f.key === "closing")?.value).toBe(
    c.callScript.closing,
  );
  expect(groups.find((g) => g.id === "proposal")?.fields.find((f) => f.key === "strengths")?.value).toContain(
    c.proposalText.strengths[0],
  );
  expect(JSON.stringify(groups)).not.toContain("PRIVATE_EXECUTION_SENTINEL");
});
it("ワークスペース用の情報は表示名と参照だけに絞り、原文・内部情報を渡さない", () => {
  const c = content();
  c.proposalText.measures[0]!.title = "😀".repeat(1000);
  const designId = randomUUID(),
    sourceId = randomUUID();
  const result = reviewContentSummary({
    ...c,
    designVersionId: designId,
    proposalRevision: { sourceVersionId: sourceId, request: "PRIVATE_OPERATOR_SENTINEL" },
    generationJobIds: { demo_site: "PRIVATE_JOB_SENTINEL" },
    inputPath: "C:/PRIVATE_PATH_SENTINEL",
  });
  expect(result).toMatchObject({
    fixedSample: false,
    designVersionId: designId,
    proposalRevision: { sourceVersionId: sourceId },
  });
  expect(result.proposalText.measures.length).toBeLessThanOrEqual(3);
  expect(Array.from(result.proposalText.measures[0]!.title)).toHaveLength(501);
  expect(result.proposalText.measures[0]!.title.endsWith("…")).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|callScript|faq|demoSite|generationJobIds/);
  expect(
    reviewContentSummary({ designVersionId: "invalid", proposalRevision: { sourceVersionId: "invalid" } }),
  ).toMatchObject({ designVersionId: null, proposalRevision: { sourceVersionId: null } });
});

it("marks only stored mock output as a fixed sample without exposing execution metadata", () => {
  expect(reviewContentSummary({ generator: "mock", privateExecution: "PRIVATE_SENTINEL" }).fixedSample).toBe(true);
  for (const generator of ["codex", undefined, "unknown"])
    expect(reviewContentSummary({ generator, fixedSample: true }).fixedSample).toBe(false);
  expect(
    JSON.stringify(reviewContentSummary({ generator: "mock", privateExecution: "PRIVATE_SENTINEL" })),
  ).not.toContain("PRIVATE_SENTINEL");
});
