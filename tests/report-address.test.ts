import { describe, expect, it } from "vitest";
import { splitAddress } from "../scripts/report-address.ts";

describe("splitAddress", () => {
  it("通常の市区町村を取り出す", () => {
    expect(splitAddress("愛知県名古屋市中区錦1-1")).toEqual({ prefecture: "愛知県", city: "名古屋市" });
    expect(splitAddress("〒430-0903 静岡県浜松市中央区助信町32-28")).toEqual({
      prefecture: "静岡県",
      city: "浜松市",
    });
  });

  it("自治体名に市を含む市でも末尾まで保持する", () => {
    expect(splitAddress("三重県四日市市鹿間町1100")).toEqual({ prefecture: "三重県", city: "四日市市" });
    expect(splitAddress("広島県廿日市市下平良一丁目11番1号")).toEqual({
      prefecture: "広島県",
      city: "廿日市市",
    });
    expect(splitAddress("石川県野々市市三納一丁目1番地")).toEqual({ prefecture: "石川県", city: "野々市市" });
  });

  it("住所がなければ推測しない", () => {
    expect(splitAddress(null)).toEqual({ prefecture: null, city: null });
    expect(splitAddress("所在地未確認")).toEqual({ prefecture: null, city: null });
  });
});
