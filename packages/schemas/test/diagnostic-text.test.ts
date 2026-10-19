import { expect, it } from "vitest";
import { isReadableDiagnosticText } from "../src/diagnostic-text.ts";

it("日本語・補助漢字・絵文字・結合文字・改行を、正規化せず受け付ける", () => {
  for (const text of [
    "閾値が未設定",
    "𠮷野の会社 👩‍💻",
    "半角ｶﾅ 全角１２３",
    "e\u0301 と é",
    " 前回の理由\n今回の理由\t ",
  ])
    expect(isReadableDiagnosticText(text), text).toBe(true);
});
it("置換文字・孤立サロゲート・NUL・空白のみ・文字列以外を拒否する", () => {
  for (const value of [
    "\uFFFD",
    "理由\uFFFD",
    "\ud800",
    "\udfff",
    "a\ud800b",
    "\0",
    "\r\n\t ",
    "",
    null,
    undefined,
    1,
    {},
    ["理由"],
  ])
    expect(isReadableDiagnosticText(value)).toBe(false);
});
