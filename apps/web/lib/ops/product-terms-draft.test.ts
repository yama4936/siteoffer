import { describe, expect, it } from "vitest";
import { EMPTY_PRODUCT_TERMS_DRAFT, inspectProductTermsDraft, readProductTermsDraft } from "./product-terms-draft";

const base = { ...EMPTY_PRODUCT_TERMS_DRAFT, version: "test-v1", name: "架空テスト用条件" };

describe("販売条件の入力と報酬プレビュー", () => {
  it("空欄を未設定として残し、0円と区別する", () => {
    expect(inspectProductTermsDraft(base).input).toMatchObject({ price: null, monthlyFee: null, rewardRule: null });
    expect(
      inspectProductTermsDraft({ ...base, price: "0", monthlyFee: "０", rewardType: "fixed", rewardValue: "0" }),
    ).toMatchObject({
      errors: {},
      rewardAmount: 0,
      input: { price: 0, monthlyFee: 0, rewardRule: { type: "fixed", amount: 0 } },
    });
  });
  it("全角数字と正しい3桁区切りを受け入れ、月額を割合報酬へ含めない", () => {
    const result = inspectProductTermsDraft({
      ...base,
      price: " ３００，００１ ",
      monthlyFee: "5,000",
      rewardType: "rate",
      rewardValue: "１２．５",
    });
    expect(result).toMatchObject({
      errors: {},
      price: 300001,
      monthlyFee: 5000,
      rewardAmount: 37500,
      input: { rewardRule: { type: "rate", basisPoints: 1250 } },
    });
  });
  it("小数第2位と境界0・100%を正確に保持し、円未満だけを既存式で切り捨てる", () => {
    for (const [value, basisPoints, amount] of [
      ["0", 0, 0],
      ["0.01", 1, 1],
      ["1.15", 115, 115],
      ["99.99", 9999, 9999],
      ["100.00", 10000, 10001],
    ] as const) {
      expect(
        inspectProductTermsDraft({ ...base, price: "10001", rewardType: "rate", rewardValue: value }),
      ).toMatchObject({ errors: {}, rewardAmount: amount, rewardRule: { type: "rate", basisPoints } });
    }
  });
  it("価格未設定でも定額報酬は確認でき、割合報酬は金額を捏造しない", () => {
    expect(inspectProductTermsDraft({ ...base, rewardType: "fixed", rewardValue: "1,234" }).rewardAmount).toBe(1234);
    expect(inspectProductTermsDraft({ ...base, rewardType: "rate", rewardValue: "10" })).toMatchObject({
      rewardAmount: null,
      errors: {},
    });
  });
  it("DBで保存できる上限を扱い、上限超過や数値の一部だけを採用しない", () => {
    expect(
      inspectProductTermsDraft({ ...base, price: "2,147,483,647", rewardType: "rate", rewardValue: "100" })
        .rewardAmount,
    ).toBe(2147483647);
    for (const value of [
      "2147483648",
      "-1",
      "1.5",
      "3,00",
      "1,000,00",
      "1e3",
      "1_000",
      "Infinity",
      "100円",
      "9007199254740993",
      "1 000",
    ]) {
      for (const field of ["price", "monthlyFee"] as const)
        expect(inspectProductTermsDraft({ ...base, [field]: value }).errors[field], value).toBeTruthy();
      expect(
        inspectProductTermsDraft({ ...base, rewardType: "fixed", rewardValue: value }).errors.rewardValue,
        value,
      ).toBeTruthy();
    }
  });
  it("割合の桁超過と選択済み報酬の空欄を未設定へ落とさない", () => {
    for (const value of ["", "10.001", "100.01", "-0.1", "1e1", "10%", "0x10", "1."]) {
      const result = inspectProductTermsDraft({ ...base, rewardType: "rate", rewardValue: value });
      expect(result.errors.rewardValue, value).toBeTruthy();
      expect(result.input).toBeNull();
      expect(result.rewardAmount).toBeNull();
    }
    expect(inspectProductTermsDraft({ ...base, rewardType: "fixed" }).input).toBeNull();
    expect(inspectProductTermsDraft({ ...base, rewardValue: "10" }).input).toBeNull();
    expect(inspectProductTermsDraft({ ...base, rewardType: "constructor" }).errors.rewardType).toBeTruthy();
  });
  it("必須文字と長さを検証し、提供範囲はJSON扱いせず文章として保存する", () => {
    expect(inspectProductTermsDraft({ ...base, version: " ", name: " " }).errors).toHaveProperty("version");
    expect(inspectProductTermsDraft({ ...base, name: "x".repeat(201) }).input).toBeNull();
    expect(inspectProductTermsDraft({ ...base, scope: "x".repeat(10001) }).input).toBeNull();
    expect(inspectProductTermsDraft({ ...base, scope: '  {"pages":3}\n写真は顧客提供  ' }).input?.scopeText).toBe(
      '{"pages":3}\n写真は顧客提供',
    );
  });
});

it("FormDataの同名重複・ファイル・過大入力を拒否し、Reactのメタデータとは分ける", () => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(base)) fd.set(key, value);
  fd.set("$ACTION_KEY", "metadata");
  expect(readProductTermsDraft(fd)).toEqual(base);
  fd.append("price", "1");
  expect(readProductTermsDraft(fd)).toBeNull();
  fd.delete("price");
  fd.set("price", new Blob(["1"]), "amount.txt");
  expect(readProductTermsDraft(fd)).toBeNull();
  fd.delete("price");
  fd.set("scope", "x".repeat(10001));
  expect(readProductTermsDraft(fd)).toBeNull();
});
