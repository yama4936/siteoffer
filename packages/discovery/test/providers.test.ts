import { readFileSync } from "node:fs";
import { fixedClock } from "@siteoffer/core";
import { describe, expect, it } from "vitest";
import { FixtureProvider, loadFixtureCompanies } from "../src/providers/fixture.ts";
import { type FetchLike, NtaCorporateNumberProvider, parseNtaXml } from "../src/providers/nta.ts";

const clock = fixedClock("2026-10-14T03:00:00Z");
const ctx = { clock };
const ntaFixture = (f: string) =>
  readFileSync(new URL(`../../../fixtures/discovery/nta/${f}`, import.meta.url), "utf8");

/** 記録済み応答を返す fetch。呼ばれたURLを残す */
function recordedFetch(route: (url: URL) => { status: number; body: string }) {
  const calls: string[] = [];
  const fetch: FetchLike = async (u) => {
    calls.push(u);
    const r = route(new URL(u));
    return { status: r.status, text: async () => r.body };
  };
  return { fetch, calls };
}

const env = { NTA_APPLICATION_ID: "TESTAPPID0001" };

describe("フィクスチャ", () => {
  it("法人番号はすべてチェックデジットが誤っており、実在の法人番号になりえない", () => {
    for (const c of loadFixtureCompanies()) {
      if (!c.corporateNumber) continue;
      const base = c.corporateNumber.slice(1);
      let sum = 0;
      [...base].reverse().forEach((d, i) => {
        sum += Number(d) * (i % 2 === 0 ? 1 : 2);
      });
      expect(Number(c.corporateNumber[0])).not.toBe(9 - (sum % 9));
    }
  });
});

describe("FixtureProvider", () => {
  it("収集条件をZodで検証する", async () => {
    const r = await new FixtureProvider().discover({ limit: 0 }, ctx);
    expect(r).toMatchObject({ ok: false, error: "invalid_criteria" });
    const r2 = await new FixtureProvider().discover({ city: "名古屋市" }, ctx);
    expect(r2).toMatchObject({ ok: false, error: "invalid_criteria" });
  });

  it("地域で絞り、出典URL・取得日時・外部IDを付ける", async () => {
    const r = await new FixtureProvider().discover({ prefecture: "愛知県", city: "名古屋市" }, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.map((c) => c.externalId).sort()).toEqual(["F001", "F002", "F003", "F004", "F008", "F009"]);
    for (const c of r.value) {
      expect(c.sourceUrl).toMatch(/^https:\/\/directory\.example\//);
      expect(c.fetchedAt).toEqual(clock.now());
      expect(c.city?.startsWith("名古屋市")).toBe(true);
    }
  });

  it("上限件数で打ち切る", async () => {
    const r = await new FixtureProvider().discover({ prefecture: "愛知県", limit: 2 }, ctx);
    expect(r.ok && r.value.length).toBe(2);
  });
});

describe("NtaCorporateNumberProvider", () => {
  it("アプリケーションIDがなければ明確なエラーを返し、通信しない", async () => {
    const { fetch, calls } = recordedFetch(() => ({ status: 200, body: "" }));
    const r = await new NtaCorporateNumberProvider({ env: {}, fetch }).discover({ prefecture: "愛知県" }, ctx);
    expect(r).toMatchObject({ ok: false, error: "nta_application_id_missing" });
    expect(r.ok ? "" : r.message).toContain("NTA_APPLICATION_ID");
    expect(calls).toHaveLength(0);
  });

  it("キーワードなしで都道府県もなければエラー", async () => {
    const { fetch } = recordedFetch(() => ({ status: 200, body: "" }));
    const r = await new NtaCorporateNumberProvider({ env, fetch }).discover({}, ctx);
    expect(r).toMatchObject({ ok: false, error: "nta_prefecture_required" });
  });

  it("所在地（都道府県コード）と取得期間で diff を呼び、分割応答をすべて取得して解析する", async () => {
    const { fetch, calls } = recordedFetch((u) => ({
      status: 200,
      body: ntaFixture(u.searchParams.get("divide") === "2" ? "diff-aichi-2.xml" : "diff-aichi-1.xml"),
    }));
    const r = await new NtaCorporateNumberProvider({ env, fetch, diffWindowDays: 30 }).discover(
      { prefecture: "愛知県" },
      ctx,
    );
    if (!r.ok) throw new Error(`${r.error} ${r.message}`);

    expect(calls).toHaveLength(2);
    const first = new URL(calls[0]!);
    expect(first.origin + first.pathname).toBe("https://api.houjin-bangou.nta.go.jp/4/diff");
    expect(first.searchParams.get("id")).toBe("TESTAPPID0001");
    expect(first.searchParams.get("address")).toBe("23");
    expect(first.searchParams.get("type")).toBe("12");
    expect(first.searchParams.get("to")).toBe("2026-10-14");
    expect(first.searchParams.get("from")).toBe("2026-09-15");
    expect(new URL(calls[1]!).searchParams.get("divide")).toBe("2");

    // 検索対象除外・閉鎖・過去履歴は除き、同じ法人番号は1件にする
    expect(r.value.map((c) => c.corporateNumber)).toEqual(["8180009990001", "4180009990005", "5180009990004"]);
    const kita = r.value.find((c) => c.corporateNumber === "5180009990004")!;
    expect(kita).toMatchObject({ name: "株式会社さくら商事", prefecture: "愛知県", city: "名古屋市北区" });
    // 出典URLにアプリケーションIDを含めない
    for (const c of r.value) {
      expect(c.sourceUrl).not.toContain("TESTAPPID0001");
      expect(c.addressSourceUrl).toBe(c.sourceUrl);
      expect(c.industry).toBeNull();
    }
  });

  it("市区町村名を指定すると、応答の市区町村名で絞る", async () => {
    const { fetch } = recordedFetch((u) => ({
      status: 200,
      body: ntaFixture(u.searchParams.get("divide") === "2" ? "diff-aichi-2.xml" : "diff-aichi-1.xml"),
    }));
    const r = await new NtaCorporateNumberProvider({ env, fetch }).discover(
      { prefecture: "愛知県", city: "名古屋市" },
      ctx,
    );
    expect(r.ok && r.value.map((c) => c.city)).toEqual(["名古屋市中区", "名古屋市北区"]);
  });

  it("キーワードは法人名検索（部分一致）。「名古屋」を含む岐阜県の法人は岐阜県のまま", async () => {
    const { fetch, calls } = recordedFetch(() => ({ status: 200, body: ntaFixture("name-nagoya.xml") }));
    const r = await new NtaCorporateNumberProvider({ env, fetch }).discover({ keywords: ["名古屋"] }, ctx);
    if (!r.ok) throw new Error(r.error);
    const u = new URL(calls[0]!);
    expect(u.pathname).toBe("/4/name");
    expect(u.searchParams.get("name")).toBe("名古屋");
    expect(u.searchParams.get("mode")).toBe("2");
    expect(u.searchParams.get("address")).toBeNull();
    const seimitsu = r.value.find((c) => c.name === "株式会社名古屋精密")!;
    expect(seimitsu).toMatchObject({ prefecture: "岐阜県", city: "岐阜市" });
  });

  it("上限件数で打ち切り、残りの分割は取りに行かない", async () => {
    const { fetch, calls } = recordedFetch(() => ({ status: 200, body: ntaFixture("diff-aichi-1.xml") }));
    const r = await new NtaCorporateNumberProvider({ env, fetch }).discover({ prefecture: "愛知県", limit: 1 }, ctx);
    expect(r.ok && r.value.length).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("HTTPエラーを Result で返す", async () => {
    const cases: [number, string][] = [
      [400, "nta_bad_request"],
      [403, "nta_rate_limited"],
      [404, "nta_invalid_application_id"],
      [500, "nta_server_error"],
    ];
    for (const [status, error] of cases) {
      const { fetch } = recordedFetch(() => ({ status, body: "051,所在地は2桁又は5桁で指定してください。" }));
      const r = await new NtaCorporateNumberProvider({ env, fetch }).discover({ prefecture: "愛知県" }, ctx);
      expect(r).toMatchObject({ ok: false, error });
    }
    const throwing: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await new NtaCorporateNumberProvider({ env, fetch: throwing }).discover({ prefecture: "愛知県" }, ctx);
    expect(r).toMatchObject({ ok: false, error: "network_error" });
  });

  it("XMLの解析：ヘッダー・エスケープ・空要素", () => {
    const r = parseNtaXml(
      '<?xml version="1.0" encoding="UTF-8"?><corporations><lastUpdateDate>2026-10-13</lastUpdateDate><count>1</count><divideNumber>1</divideNumber><divideSize>1</divideSize><corporation><sequenceNumber>1</sequenceNumber><corporateNumber>8180009990001</corporateNumber><name>株式会社Ａ&amp;Ｂ</name><nameImageId/><prefectureName>愛知県</prefectureName><cityName>名古屋市中区</cityName><streetNumber/><closeDate/><latest>1</latest><hihyoji>0</hihyoji></corporation></corporations>',
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toMatchObject({ lastUpdateDate: "2026-10-13", count: 1, divideSize: 1 });
    expect(r.value.corporations[0]).toMatchObject({ name: "株式会社Ａ&Ｂ", streetNumber: "", closeDate: "" });
    expect(parseNtaXml("not xml")).toMatchObject({ ok: false, error: "nta_unexpected_response" });
  });
});

it("NTA transport timeout and remote errors never expose the application ID", async () => {
  for (const fetch of [
    async () => {
      throw new Error(`failed https://example.test/?id=${env.NTA_APPLICATION_ID}`);
    },
    async () => ({ status: 400, text: async () => env.NTA_APPLICATION_ID }),
    async () => ({ status: 200, text: async () => new Promise<string>(() => {}) }),
  ] as FetchLike[]) {
    const r = await new NtaCorporateNumberProvider({ env, fetch, requestTimeoutMs: 20 }).discover(
      { prefecture: "愛知県" },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(env.NTA_APPLICATION_ID);
  }
});
