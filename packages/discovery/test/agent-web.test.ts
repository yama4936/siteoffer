import { err, fixedClock, ok } from "@siteoffer/core";
import { companies, type Db, discoverySources, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { agentWebFileSchema } from "@siteoffer/schemas";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PageFetcher } from "../src/fetch-page.ts";
import { AGENT_WEB_PROVIDER, createAgentWebProviders } from "../src/providers/agent-web.ts";
import { createDiscoveryJob, runDiscovery } from "../src/run.ts";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-27T00:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

const at = "2026-10-27T10:00:00+09:00";
const file = agentWebFileSchema.parse({
  criteria: { prefecture: "愛知県", city: "名古屋市", industry: "工務店" },
  candidates: [
    {
      // 社名と所在地を会社概要で確認できた
      name: "株式会社架空工務店",
      prefecture: "愛知県",
      city: "名古屋市緑区",
      address: "愛知県名古屋市緑区架空町1-2-3",
      address_source_url: "https://kakuu-koumuten.example.jp/company/",
      found_via: { url: "https://kumiai.example.jp/members/" },
      fetched_at: at,
      official_site: {
        url: "https://www.kakuu-koumuten.example.jp/",
        evidence_url: "https://kakuu-koumuten.example.jp/company/",
        evidence: { company_name: "株式会社架空工務店", address: "愛知県名古屋市緑区架空町1-2-3" },
      },
    },
    {
      // 社名は確認できたが所在地は書かれていない
      name: "有限会社架空建築",
      found_via: { url: "https://kumiai.example.jp/members/" },
      fetched_at: at,
      official_site: {
        url: "https://kakuu-kenchiku.example.jp/",
        evidence_url: "https://kakuu-kenchiku.example.jp/",
        evidence: { company_name: "（有）架空建築" },
      },
    },
    {
      // SNSしか見つからない
      name: "架空ハウス株式会社",
      prefecture: "愛知県",
      city: "名古屋市北区",
      address: "愛知県名古屋市北区架空1-1",
      address_source_url: "https://kumiai.example.jp/members/",
      found_via: { url: "https://kumiai.example.jp/members/" },
      fetched_at: at,
      official_site: null,
      other_sites: [{ url: "https://www.instagram.com/kakuu_house/" }],
    },
    {
      // 出典の所在地が条件の地域外
      name: "株式会社架空住建",
      prefecture: "岐阜県",
      city: "岐阜市",
      address: "岐阜県岐阜市架空2-2",
      address_source_url: "https://kakuu-juken.example.jp/about/",
      found_via: { url: "https://search.example/?q=名古屋 工務店" },
      fetched_at: at,
      official_site: {
        url: "https://kakuu-juken.example.jp/",
        evidence_url: "https://kakuu-juken.example.jp/about/",
        evidence: { company_name: "株式会社架空住建", address: "岐阜県岐阜市架空2-2" },
      },
    },
    {
      // AIの幻覚：evidence には社名・所在地・法人番号が書かれているが、実際のページには社名がない
      name: "株式会社架空幻覚",
      corporate_number: "6180009990101",
      prefecture: "愛知県",
      city: "名古屋市中区",
      address: "愛知県名古屋市中区架空3-3",
      address_source_url: "https://kakuu-genkaku.example.jp/company/",
      found_via: { url: "https://search.example/?q=名古屋 工務店" },
      fetched_at: at,
      official_site: {
        url: "https://kakuu-genkaku.example.jp/",
        evidence_url: "https://kakuu-genkaku.example.jp/company/",
        evidence: {
          company_name: "株式会社架空幻覚",
          address: "愛知県名古屋市中区架空3-3",
          corporate_number: "6180009990101",
        },
      },
    },
    {
      // 公式サイトに接続できない
      name: "株式会社架空閉業",
      found_via: { url: "https://kumiai.example.jp/members/" },
      fetched_at: at,
      official_site: {
        url: "https://kakuu-heigyou.example.jp/",
        evidence_url: "https://kakuu-heigyou.example.jp/",
        evidence: { company_name: "株式会社架空閉業" },
      },
    },
  ],
});

/** 公式サイトの模擬応答（実在企業のサイトには接続しない） */
const PAGES: Record<string, string> = {
  "https://www.kakuu-koumuten.example.jp/": "<h1>架空工務店</h1>",
  "https://kakuu-koumuten.example.jp/company/":
    "<dl><dt>商号</dt><dd>株式会社架空工務店</dd><dt>所在地</dt><dd>愛知県名古屋市緑区架空町1-2-3</dd></dl>",
  "https://kakuu-kenchiku.example.jp/": "<footer>© 有限会社 架空建築</footer>",
  "https://kakuu-juken.example.jp/": "<h1>株式会社架空住建</h1>",
  "https://kakuu-juken.example.jp/about/": "<p>株式会社架空住建 岐阜県岐阜市架空2-2</p>",
  "https://kakuu-genkaku.example.jp/": "<p>このドメインは売却中です</p>",
  "https://kakuu-genkaku.example.jp/company/": "<p>Not Found</p>",
};
const fetchPage: PageFetcher = async (url) => {
  const body = PAGES[url];
  return body === undefined
    ? err("network_error", "接続に失敗")
    : ok({ finalUrl: url, status: 200, contentType: "text/html", body });
};

async function run() {
  const job = await createDiscoveryJob(db, clock, { provider: AGENT_WEB_PROVIDER, criteria: file.criteria });
  if (!job.ok) throw new Error(job.error);
  const r = await runDiscovery(
    db,
    clock,
    job.value.jobId,
    createAgentWebProviders(file.candidates, { fetchPage, nta: null }),
  );
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const byName = async (name: string) => (await db.select().from(companies).where(eq(companies.name, name)))[0];

describe("agent-web（company-discovery スキルの候補）", () => {
  it("実際に取得したページから公式サイトの確度を決め、実在を確認できない候補と地域外の候補は保存しない", async () => {
    const s = await run();
    expect(s).toMatchObject({ status: "succeeded", found: 6, created: 2, skipped: 4, failed: 0 });

    expect(await byName("株式会社架空工務店")).toMatchObject({
      officialSiteStatus: "confirmed",
      pipelineStatus: "collected",
      city: "名古屋市緑区",
      addressSourceUrl: "https://kakuu-koumuten.example.jp/company/",
    });
    expect(await byName("有限会社架空建築")).toMatchObject({ officialSiteStatus: "candidate", city: null });
    // SNSしかない・ページに社名がない・接続できない候補は企業を作らず、理由を残す
    expect(await byName("架空ハウス株式会社")).toBeUndefined();
    expect(await byName("株式会社架空幻覚")).toBeUndefined();
    expect(await byName("株式会社架空閉業")).toBeUndefined();
    expect(await byName("株式会社架空住建")).toBeUndefined();
    expect(s.failures.some((f) => f.reason.startsWith("area_mismatch"))).toBe(true);
    const unverified = s.failures.filter((f) => f.reason.startsWith("unverified: "));
    expect(unverified.map((f) => f.externalId).sort()).toEqual([
      "corp:6180009990101",
      "domain:kakuu-heigyou.example.jp",
      "name:架空ハウス株式会社|愛知県名古屋市北区",
    ]);
    expect(unverified.find((f) => f.externalId === "corp:6180009990101")?.reason).toContain(
      "公式サイトの本文に社名がない",
    );
    expect(unverified.find((f) => f.externalId === "corp:6180009990101")?.reason).toContain(
      "国税庁APIでの照合は省略（アプリケーションID未設定）",
    );

    // 第三者サイトは企業のサイトとして保存しない
    const sites = await db.select({ url: websites.normalizedUrl }).from(websites);
    expect(sites.map((w) => w.url).sort()).toEqual([
      "https://kakuu-kenchiku.example.jp",
      "https://kakuu-koumuten.example.jp",
    ]);

    // 公式サイトの証拠は取得した本文から作り、照合の経過を取り込み元に残す
    const src = await db.select().from(discoverySources).where(eq(discoverySources.role, "company"));
    expect(src).toHaveLength(2);
    for (const row of src) expect(row.payload).toMatchObject({ verification: { status: "accepted" } });
  });

  it("国税庁APIのIDがない場合は照合を飛ばしたことを、閉鎖法人は除外したことを記録する", async () => {
    const closed = agentWebFileSchema.parse({
      criteria: { prefecture: "愛知県" },
      candidates: [
        {
          name: "株式会社架空廃業",
          corporate_number: "5180009990102",
          found_via: { url: "https://kumiai.example.jp/members/" },
          fetched_at: at,
          official_site: {
            url: "https://kakuu-haigyou.example.jp/",
            evidence_url: "https://kakuu-haigyou.example.jp/",
            evidence: { company_name: "株式会社架空廃業" },
          },
        },
      ],
    });
    const job = await createDiscoveryJob(db, clock, { provider: AGENT_WEB_PROVIDER, criteria: closed.criteria });
    if (!job.ok) throw new Error(job.error);
    const r = await runDiscovery(
      db,
      clock,
      job.value.jobId,
      createAgentWebProviders(closed.candidates, {
        fetchPage: async (url) =>
          ok({ finalUrl: url, status: 200, contentType: "text/html", body: "<h1>株式会社架空廃業</h1>" }),
        nta: {
          hasApplicationId: () => true,
          lookupNumber: async (n) =>
            ok({
              corporation: {
                sequenceNumber: "1",
                corporateNumber: n,
                process: "71",
                updateDate: "2025-04-01",
                name: "株式会社架空廃業",
                kind: "301",
                prefectureName: "愛知県",
                cityName: "名古屋市中区",
                streetNumber: "架空1-1",
                prefectureCode: "23",
                cityCode: "106",
                postCode: "",
                closeDate: "2025-03-31",
                latest: "1",
                furigana: "",
                hihyoji: "0",
              },
              sourceUrl: `https://api.houjin-bangou.nta.go.jp/4/num?number=${n}&type=12&history=0`,
            }),
        },
      }),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toMatchObject({ found: 1, created: 0, skipped: 1 });
    expect(r.value.failures[0]?.reason).toContain("登記記録が閉鎖されている（閉鎖日 2025-03-31）");
    expect(await db.select().from(companies)).toHaveLength(0);
  });

  it("同じ候補ファイルの再実行で企業が増えず、営業抑止も戻らない（AC-03）", async () => {
    await run();
    const target = await byName("株式会社架空工務店");
    await db
      .update(companies)
      .set({ suppression: "do_not_contact", suppressionReason: "テスト" })
      .where(eq(companies.id, target!.id));

    const s = await run();
    expect(s).toMatchObject({ status: "succeeded", created: 0 });
    expect(await db.select().from(companies)).toHaveLength(2);
    expect(await byName("株式会社架空工務店")).toMatchObject({ suppression: "do_not_contact" });
    expect(s.failures.some((f) => f.reason === "suppressed: do_not_contact")).toBe(true);
  });
});
