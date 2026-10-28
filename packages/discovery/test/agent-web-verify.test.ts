import { err, ok } from "@siteoffer/core";
import { agentWebCandidateSchema } from "@siteoffer/schemas";
import { describe, expect, it } from "vitest";
import type { PageFetcher } from "../src/fetch-page.ts";
import { findAddressOnPage, findCorporateNumbers, htmlToText, textMentionsCompanyName } from "../src/page-facts.ts";
import { type NtaLookup, verifyAgentWebCandidate } from "../src/providers/agent-web-verify.ts";
import { NtaCorporateNumberProvider, type NtaCorporation } from "../src/providers/nta.ts";

// 検査用数字が正しい架空の法人番号
const NUM = "6180009990101";
const OTHER = "5180009990102";

const at = "2026-10-27T10:00:00+09:00";
const cand = (over: Record<string, unknown> = {}) =>
  agentWebCandidateSchema.parse({
    name: "株式会社架空工務店",
    corporate_number: NUM,
    prefecture: "愛知県",
    city: "名古屋市緑区",
    address: "愛知県名古屋市緑区架空町1-2-3",
    address_source_url: "https://kakuu-koumuten.example.jp/company/",
    found_via: { url: "https://kumiai.example.jp/members/" },
    fetched_at: at,
    official_site: {
      url: "https://kakuu-koumuten.example.jp/",
      evidence_url: "https://kakuu-koumuten.example.jp/company/",
      // AIの申告。照合には使わない
      evidence: { company_name: "株式会社架空工務店", address: "愛知県名古屋市緑区架空町1-2-3", corporate_number: NUM },
    },
    ...over,
  });

function pages(map: Record<string, string>): { fetchPage: PageFetcher; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchPage: async (url) => {
      calls.push(url);
      const body = map[url];
      return body === undefined
        ? err("network_error", "接続に失敗")
        : ok({ finalUrl: url, status: 200, contentType: "text/html", body });
    },
  };
}

const COMPANY_PAGE = `<html><head><title>会社概要</title><script>var x="株式会社架空工務店";</script></head>
<body><h1>会社概要</h1><dl><dt>商号</dt><dd>株式会社 架空工務店</dd>
<dt>所在地</dt><dd>〒458-0000 愛知県名古屋市緑区架空町１－２－３</dd>
<dt>法人番号</dt><dd>${NUM}</dd></dl></body></html>`;

const corp = (over: Partial<NtaCorporation> = {}): NtaCorporation => ({
  sequenceNumber: "1",
  corporateNumber: NUM,
  process: "01",
  updateDate: "2026-01-01",
  name: "株式会社架空工務店",
  kind: "301",
  prefectureName: "愛知県",
  cityName: "名古屋市緑区",
  streetNumber: "架空町１－２－３",
  prefectureCode: "23",
  cityCode: "114",
  postCode: "4580000",
  closeDate: "",
  latest: "1",
  furigana: "",
  hihyoji: "0",
  ...over,
});
function nta(c: NtaCorporation | null | "error"): NtaLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hasApplicationId: () => true,
    lookupNumber: async (n: string) => {
      calls.push(n);
      if (c === "error") return err("nta_server_error", "障害");
      return ok({ corporation: c, sourceUrl: `https://api.houjin-bangou.nta.go.jp/4/num?number=${n}` });
    },
  } as NtaLookup & { calls: string[] };
}
const noNta: NtaLookup = { hasApplicationId: () => false, lookupNumber: async () => err("nta_application_id_missing") };

describe("ページ本文からの事実の抽出", () => {
  it("script を除き、社名は法人格・空白・全角半角を無視して照合する", () => {
    const text = htmlToText(COMPANY_PAGE);
    expect(text).not.toContain("var x");
    expect(textMentionsCompanyName(text, "株式会社架空工務店")).toBe(true);
    expect(textMentionsCompanyName(htmlToText("<script>株式会社架空工務店</script>"), "株式会社架空工務店")).toBe(
      false,
    );
    expect(textMentionsCompanyName("株式会社 ア", "株式会社ア")).toBe(false); // 短すぎる社名は確認できない扱い
  });

  it("法人番号は検査用数字が正しいもの（T付き・区切り付きを含む）だけ拾う", () => {
    expect(findCorporateNumbers(`登録番号 T${NUM} / 電話 1234567890123 / ５－１８００－０９９９－０１０２`)).toEqual([
      NUM,
      OTHER,
    ]);
  });

  it("所在地は都道府県＋市区町村で照合し、なければ null", () => {
    const text = htmlToText(COMPANY_PAGE);
    expect(findAddressOnPage(text, "愛知県", "名古屋市緑区")).toBe("愛知県名古屋市緑区");
    expect(findAddressOnPage(text, "岐阜県", "岐阜市")).toBeNull();
  });
});

describe("agent-web 候補の実在確認", () => {
  it("公式サイトの本文で社名・所在地・法人番号を確認できれば採用し、証拠は取得した本文から作る", async () => {
    const { fetchPage, calls } = pages({
      "https://kakuu-koumuten.example.jp/": "<h1>架空工務店</h1>",
      "https://kakuu-koumuten.example.jp/company/": COMPANY_PAGE,
    });
    const v = await verifyAgentWebCandidate(cand(), { fetchPage, nta: noNta });
    expect(v.status).toBe("accepted");
    expect(calls).toEqual(["https://kakuu-koumuten.example.jp/", "https://kakuu-koumuten.example.jp/company/"]);
    expect(v.nta).toBe("skipped_no_application_id");
    expect(v.reasons).toContain("国税庁APIでの照合は省略（アプリケーションID未設定）");
    expect(v.corporateNumber).toBe(NUM);
    expect(v.location).toMatchObject({
      prefecture: "愛知県",
      city: "名古屋市緑区",
      sourceUrl: "https://kakuu-koumuten.example.jp/company/",
    });
    expect(v.officialSite).toEqual({
      url: "https://kakuu-koumuten.example.jp/",
      evidenceUrl: "https://kakuu-koumuten.example.jp/company/",
      evidence: { companyName: "株式会社架空工務店", address: "愛知県名古屋市緑区", corporateNumber: NUM },
    });
  });

  it("AIの evidence に社名があっても、取得した本文に社名がなければ除外する（幻覚・別会社）", async () => {
    const { fetchPage } = pages({
      "https://kakuu-koumuten.example.jp/": "<h1>株式会社まったく別の会社</h1>",
      "https://kakuu-koumuten.example.jp/company/": "<p>このドメインは販売中です</p>",
    });
    const v = await verifyAgentWebCandidate(cand(), { fetchPage, nta: noNta });
    expect(v.status).toBe("excluded");
    expect(v.reasons).toContain("公式サイトの本文に社名がない");
    expect(v.officialSite).toBeNull();
    expect(v.corporateNumber).toBeNull();
  });

  it("公式サイトを取得できず、国税庁APIでも確認できなければ除外する", async () => {
    const v = await verifyAgentWebCandidate(cand(), { fetchPage: pages({}).fetchPage, nta: noNta });
    expect(v.status).toBe("excluded");
    expect(v.reasons.some((r) => r.startsWith("公式サイトを取得できない"))).toBe(true);
    expect(v.reasons.at(-1)).toMatch(/^実在を確認できない/);
  });

  it("検査用数字が合わない法人番号は信用せず、国税庁APIにも照会しない", async () => {
    const api = nta(corp());
    const { fetchPage } = pages({ "https://kakuu-koumuten.example.jp/": COMPANY_PAGE });
    const v = await verifyAgentWebCandidate(
      cand({
        corporate_number: "1234567890123",
        official_site: { ...cand().official_site!, evidence_url: "https://kakuu-koumuten.example.jp/" },
      }),
      { fetchPage, nta: api },
    );
    expect(api.calls).toEqual([]);
    expect(v.corporateNumber).toBeNull();
    expect(v.reasons[0]).toBe("法人番号の検査用数字が合わないため、申告の番号を使わない");
    expect(v.status).toBe("accepted"); // 公式サイトの本文で社名は確認できた
  });

  it("国税庁APIのIDがなく、番号が公式サイトにも書かれていなければ番号を使わない", async () => {
    const { fetchPage } = pages({
      "https://kakuu-koumuten.example.jp/": "<p>株式会社架空工務店 愛知県名古屋市緑区</p>",
    });
    const v = await verifyAgentWebCandidate(cand(), { fetchPage, nta: noNta });
    expect(v.status).toBe("accepted");
    expect(v.corporateNumber).toBeNull();
    expect(v.officialSite?.evidence.corporateNumber).toBeNull();
  });

  it("国税庁APIで確認できれば、登記の所在地を使い、サイトが取得できなくても実在は確認済みとする", async () => {
    const api = nta(corp());
    const v = await verifyAgentWebCandidate(cand(), { fetchPage: pages({}).fetchPage, nta: api });
    expect(api.calls).toEqual([NUM]);
    expect(v).toMatchObject({ status: "accepted", nta: "matched", corporateNumber: NUM, officialSite: null });
    expect(v.location).toMatchObject({ prefecture: "愛知県", city: "名古屋市緑区", address: "架空町１－２－３" });
    expect(v.location?.sourceUrl).not.toContain("id=");
  });

  it("国税庁APIに存在しない番号・商号が違う番号は使わない", async () => {
    const { fetchPage } = pages({ "https://kakuu-koumuten.example.jp/": COMPANY_PAGE });
    const missing = await verifyAgentWebCandidate(cand(), { fetchPage, nta: nta(null) });
    expect(missing).toMatchObject({ nta: "not_found", corporateNumber: null });
    const other = await verifyAgentWebCandidate(cand(), { fetchPage, nta: nta(corp({ name: "株式会社別名商事" })) });
    expect(other).toMatchObject({ nta: "name_mismatch", corporateNumber: null });
  });

  it("国税庁APIで登記記録が閉鎖されていれば、公式サイトがあっても除外する（廃業）", async () => {
    const { fetchPage } = pages({ "https://kakuu-koumuten.example.jp/": COMPANY_PAGE });
    const v = await verifyAgentWebCandidate(cand(), { fetchPage, nta: nta(corp({ closeDate: "2025-03-31" })) });
    expect(v).toMatchObject({ status: "excluded", nta: "closed", corporateNumber: null });
    expect(v.reasons.at(-1)).toBe("登記記録が閉鎖されている（閉鎖日 2025-03-31）");
  });

  it("国税庁APIの照会に失敗したら、公式サイト上の記載でだけ番号を確認する", async () => {
    const { fetchPage } = pages({ "https://kakuu-koumuten.example.jp/": COMPANY_PAGE });
    const v = await verifyAgentWebCandidate(cand(), { fetchPage, nta: nta("error") });
    expect(v).toMatchObject({ status: "accepted", nta: "error", corporateNumber: NUM });
  });

  it("別ドメインの evidence_url・別ドメインへの転送・第三者サイトは証拠にしない", async () => {
    const offSite = await verifyAgentWebCandidate(
      cand({
        official_site: {
          url: "https://kakuu-koumuten.example.jp/",
          evidence_url: "https://portal-directory.example/kakuu",
          evidence: { company_name: "株式会社架空工務店", address: null, corporate_number: null },
        },
      }),
      { fetchPage: pages({ "https://portal-directory.example/kakuu": COMPANY_PAGE }).fetchPage, nta: noNta },
    );
    expect(offSite.status).toBe("excluded");

    const redirected = await verifyAgentWebCandidate(cand(), {
      fetchPage: async () =>
        ok({ finalUrl: "https://parking.example.net/", status: 200, contentType: "text/html", body: COMPANY_PAGE }),
      nta: noNta,
    });
    expect(redirected.status).toBe("excluded");
    expect(redirected.pages.every((p) => p.error === "redirected_off_site")).toBe(true);

    const third = await verifyAgentWebCandidate(
      cand({
        official_site: {
          url: "https://www.instagram.com/kakuu/",
          evidence_url: "https://www.instagram.com/kakuu/",
          evidence: { company_name: "株式会社架空工務店", address: null, corporate_number: null },
        },
      }),
      { fetchPage: pages({ "https://www.instagram.com/kakuu/": COMPANY_PAGE }).fetchPage, nta: noNta },
    );
    expect(third.status).toBe("excluded");
    expect(third.pages).toEqual([]);
  });
});

describe("国税庁APIの番号照会（記録済み応答。実際の接続はしない）", () => {
  it("num エンドポイントを呼び、出典URLにはIDを含めない", async () => {
    const urls: string[] = [];
    const xml = `<?xml version="1.0" encoding="UTF-8"?><corporations><lastUpdateDate>2026-10-27</lastUpdateDate><count>1</count><divideNumber>1</divideNumber><divideSize>1</divideSize><corporation><sequenceNumber>1</sequenceNumber><corporateNumber>${NUM}</corporateNumber><name>株式会社架空工務店</name><closeDate/><latest>1</latest></corporation></corporations>`;
    const p = new NtaCorporateNumberProvider({
      env: { NTA_APPLICATION_ID: "test-app-id" },
      fetch: async (url) => {
        urls.push(url);
        return { status: 200, text: async () => xml };
      },
    });
    expect(p.hasApplicationId()).toBe(true);
    const r = await p.lookupNumber(NUM);
    expect(r).toMatchObject({ ok: true, value: { corporation: { corporateNumber: NUM, closeDate: "" } } });
    expect(urls[0]).toBe(`https://api.houjin-bangou.nta.go.jp/4/num?id=test-app-id&number=${NUM}&type=12&history=0`);
    if (r.ok) expect(r.value.sourceUrl).not.toContain("test-app-id");
  });

  it("IDが未設定なら照会しない", async () => {
    const p = new NtaCorporateNumberProvider({
      env: {},
      fetch: async () => {
        throw new Error("呼ばれてはいけない");
      },
    });
    expect(p.hasApplicationId()).toBe(false);
    expect(await p.lookupNumber(NUM)).toMatchObject({ ok: false, error: "nta_application_id_missing" });
  });
});
