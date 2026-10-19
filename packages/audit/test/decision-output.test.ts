import { expect, it } from "vitest";
import { parseDecideOutput } from "../src/scripts.ts";

it("判定値は自分のキーだけで照合し、null・配列・prototypeの名前で成功しない", () => {
  for (const raw of [
    null,
    [],
    "create",
    1,
    true,
    {},
    { decision: "constructor", reasons: ["理由"] },
    { decision: "__proto__", reasons: ["理由"] },
    { decision: "toString", reasons: ["理由"] },
    { decision: { private: "fixture-private" }, reasons: ["理由"] },
  ]) {
    const result = parseDecideOutput(JSON.stringify(raw));
    expect(result).toMatchObject({ ok: false, error: "decide_failed" });
    expect(JSON.stringify(result)).not.toContain("fixture-private");
  }
});
it("理由をStringへ強制変換せず、文字化け・欠落・不正なUnicodeを保存可能にしない", () => {
  for (const reasons of [
    undefined,
    null,
    [],
    "理由",
    [1],
    [null],
    [{}],
    [""],
    ["  "],
    ["読めない\uFFFD"],
    ["\ud800"],
    ["\0"],
    ["正常", false],
  ])
    expect(parseDecideOutput(JSON.stringify({ decision: "create", reasons }))).toMatchObject({
      ok: false,
      error: "decide_failed",
    });
});
it("正しい理由のバイトに相当する文字列と、判定の追加メタデータを保持する", () => {
  const reasons = ["  閾値が未設定。\n𠮷野 😀 e\u0301  ", "半角ｶﾅ 全角１２３"];
  for (const [decision, mapped] of [
    ["create", "create"],
    ["skip", "skip"],
    ["pending", "hold"],
  ]) {
    const raw = {
      decision,
      reasons,
      threshold: null,
      threshold_source: "config",
      custom: { future: "原本のメタデータ" },
    };
    const result = parseDecideOutput(JSON.stringify(raw));
    expect(result).toMatchObject({ ok: true, value: { decision: mapped, reasons, raw } });
    if (result.ok) {
      expect(result.value.reasons).not.toBe(result.value.raw.reasons);
      expect(result.value.raw).toEqual(raw);
    }
  }
});
