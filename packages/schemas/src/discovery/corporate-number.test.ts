import { describe, expect, it } from "vitest";
import { agentWebCandidateSchema, corporateNumberCheckDigit, isValidCorporateNumber } from "./index.ts";

describe("法人番号の検査用数字", () => {
  it("国税庁の算式（9 − Σ Pn×Qn mod 9）で計算する", () => {
    // 国税庁の説明資料の計算例（基礎番号 000012050002 → 検査用数字 7）
    expect(corporateNumberCheckDigit("000012050002")).toBe(7);
    expect(corporateNumberCheckDigit("180009990101")).toBe(6);
    // 合計が9の倍数なら 9
    expect(corporateNumberCheckDigit("000000000000")).toBe(9);
    expect(corporateNumberCheckDigit("12345")).toBeNull();
  });

  it("13桁の形式と検査用数字の両方を満たすものだけ正しい", () => {
    expect(isValidCorporateNumber("7000012050002")).toBe(true);
    expect(isValidCorporateNumber("6180009990101")).toBe(true);
    expect(isValidCorporateNumber("5180009990101")).toBe(false);
    expect(isValidCorporateNumber("1234567890123")).toBe(false);
    expect(isValidCorporateNumber("618000999010")).toBe(false);
    expect(isValidCorporateNumber("６180009990101")).toBe(false);
  });

  it("候補ファイルの形式検査は検査用数字で落とさない（取り込み時に照合して番号だけ捨てる）", () => {
    const r = agentWebCandidateSchema.safeParse({
      name: "株式会社架空",
      corporate_number: "1234567890123",
      found_via: { url: "https://directory.example/" },
      fetched_at: "2026-10-27T10:00:00+09:00",
      official_site: null,
    });
    expect(r.success).toBe(true);
  });
});
