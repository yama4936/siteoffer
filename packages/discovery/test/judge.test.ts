import { fixedClock } from "@siteoffer/core";
import { describe, expect, it } from "vitest";
import { type CompanyFacts, compareAddress, judgeOfficialSite, mergeOfficialSiteStatus } from "../src/judge.ts";
import { MockSearchProvider } from "../src/providers/search.ts";

const clock = fixedClock("2026-10-14T00:00:00Z");
const search = new MockSearchProvider();

async function judge(company: CompanyFacts) {
  const r = await search.findOfficialSite(company, { clock });
  if (!r.ok) throw new Error(r.error);
  return judgeOfficialSite(company, r.value);
}

const base = { corporateNumber: null, address: null };

describe("公式URLの確度", () => {
  it("法人番号または社名＋所在地が一致すれば confirmed。同じ企業の別ドメインも保存対象で、法人番号一致を主にする", async () => {
    const j = await judge({
      ...base,
      name: "株式会社架空精工",
      corporateNumber: "8180009990001",
      prefecture: "愛知県",
      city: "名古屋市中区",
    });
    expect(j.status).toBe("confirmed");
    expect(j.sites.map((s) => s.normalizedUrl)).toEqual([
      "https://kakuseiko.test",
      "https://kakuseiko-online.test/shop",
    ]);
    expect(j.judged.find((s) => s.domain === "portal-directory.example")?.verdict).toBe("third_party");
  });

  it("社名は一致するが所在地を確認できなければ candidate", async () => {
    const j = await judge({ ...base, name: "有限会社ひだまり工務店", prefecture: "愛知県", city: "名古屋市千種区" });
    expect(j.status).toBe("candidate");
    expect(j.sites).toHaveLength(1);
  });

  it("第三者サイト（ポータル・SNS）しか見つからなければ needs_review", async () => {
    const j = await judge({ ...base, name: "株式会社みなと設備", prefecture: "愛知県", city: "名古屋市港区" });
    expect(j.status).toBe("needs_review");
    expect(j.sites).toHaveLength(0);
    expect(j.judged.every((s) => s.verdict === "third_party")).toBe(true);
  });

  it("同名の別企業（所在地が違う）のサイトしかなければ needs_review。所在地が合う側は confirmed", async () => {
    const kita = await judge({ ...base, name: "株式会社さくら商事", prefecture: "愛知県", city: "名古屋市北区" });
    expect(kita.status).toBe("needs_review");
    expect(kita.judged.find((s) => s.domain === "sakura-shoji.test")?.verdict).toBe("other_company");

    const kasugai = await judge({ ...base, name: "株式会社さくら商事", prefecture: "愛知県", city: "春日井市" });
    expect(kasugai.status).toBe("confirmed");
    expect(kasugai.sites.map((s) => s.domain)).toEqual(["sakura-shoji.test"]);
  });

  it("検索結果がなければ not_found", async () => {
    const j = await judge({ ...base, name: "株式会社つばめ運送", prefecture: "愛知県", city: "一宮市" });
    expect(j.status).toBe("not_found");
  });

  it("ページ上の法人番号が別の法人なら、社名が同じでも採用しない", () => {
    const j = judgeOfficialSite(
      { ...base, name: "株式会社あおば印刷", corporateNumber: "1000000000000", prefecture: null, city: null },
      [
        {
          provider: "t",
          externalId: "x",
          url: "https://aoba-print.test/",
          title: null,
          sourceUrl: "https://search.example/?q=x",
          fetchedAt: clock.now(),
          thirdParty: false,
          evidence: { companyName: "株式会社あおば印刷", address: null, corporateNumber: "9180009990009" },
        },
      ],
    );
    expect(j.status).toBe("needs_review");
  });

  it("所在地の照合：都道府県が違えば食い違い、企業側が不明なら判定しない", () => {
    const nagoya = { ...base, name: "x", prefecture: "愛知県", city: "名古屋市中区" };
    expect(compareAddress(nagoya, "愛知県名古屋市中区錦1-1")).toBe("match");
    expect(compareAddress(nagoya, "名古屋市中区錦1-1")).toBe("match");
    expect(compareAddress(nagoya, "岐阜県岐阜市名古屋町1")).toBe("mismatch");
    expect(compareAddress({ ...nagoya, prefecture: null, city: null }, "名古屋市中区")).toBe("unknown");
  });

  it("確認済みは再収集の結果で下げない", () => {
    expect(mergeOfficialSiteStatus("confirmed", "needs_review")).toBe("confirmed");
    expect(mergeOfficialSiteStatus("candidate", "needs_review")).toBe("needs_review");
    expect(mergeOfficialSiteStatus("not_found", "confirmed")).toBe("confirmed");
  });
});
