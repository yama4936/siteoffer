import { describe, expect, it } from "vitest";
import { PROPOSAL_PRECHECK_KEYS, parseProposalPrecheck } from "./proposal-precheck.ts";

const passed = {
  status: "passed",
  checkedAt: "2026-10-28T01:02:03.000Z",
  checker: { checkPy: "a".repeat(64) },
  siteDigest: `sha256:${"b".repeat(64)}`,
  items: PROPOSAL_PRECHECK_KEYS.map((key) => ({ key, ok: true, summary: `${key} OK`, details: [] })),
};

describe("parseProposalPrecheck", () => {
  it("正しい形の passed / failed を読める", () => {
    expect(parseProposalPrecheck(passed)).toEqual(passed);
    const failed = {
      ...passed,
      status: "failed",
      items: passed.items.map((i) => (i.key === "links" ? { ...i, ok: false, details: ["リンク切れ: /contact"] } : i)),
    };
    expect(parseProposalPrecheck(failed)?.status).toBe("failed");
  });
  it("不正な値・未実施は null", () => {
    for (const value of [
      undefined,
      null,
      "passed",
      {},
      { ...passed, status: "ok" },
      { ...passed, checkedAt: "昨日" },
      { ...passed, checker: { checkPy: "xyz" } },
      { ...passed, siteDigest: "" },
      { ...passed, items: passed.items.slice(1) },
      { ...passed, items: [...passed.items.slice(1), passed.items[1]] },
      { ...passed, items: passed.items.map((i) => ({ ...i, key: i.key === "company" ? "rights" : i.key })) },
      { ...passed, items: passed.items.map((i) => (i.key === "devices" ? { ...i, ok: false } : i)) },
      { ...passed, extra: true },
    ])
      expect(parseProposalPrecheck(value)).toBeNull();
  });
});
