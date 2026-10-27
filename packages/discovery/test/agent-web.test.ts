import { fixedClock } from "@siteoffer/core";
import { companies, type Db, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { agentWebFileSchema } from "@siteoffer/schemas";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  ],
});

async function run() {
  const job = await createDiscoveryJob(db, clock, { provider: AGENT_WEB_PROVIDER, criteria: file.criteria });
  if (!job.ok) throw new Error(job.error);
  const r = await runDiscovery(db, clock, job.value.jobId, createAgentWebProviders(file.candidates));
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const byName = async (name: string) => (await db.select().from(companies).where(eq(companies.name, name)))[0];

describe("agent-web（company-discovery スキルの候補）", () => {
  it("ページ上の証拠から公式サイトの確度を決め、地域外の候補は保存しない", async () => {
    const s = await run();
    expect(s).toMatchObject({ status: "succeeded", found: 4, created: 3, skipped: 1, failed: 0 });

    expect(await byName("株式会社架空工務店")).toMatchObject({
      officialSiteStatus: "confirmed",
      pipelineStatus: "collected",
      city: "名古屋市緑区",
      addressSourceUrl: "https://kakuu-koumuten.example.jp/company/",
    });
    expect(await byName("有限会社架空建築")).toMatchObject({ officialSiteStatus: "candidate", city: null });
    expect(await byName("架空ハウス株式会社")).toMatchObject({ officialSiteStatus: "needs_review" });
    expect(await byName("株式会社架空住建")).toBeUndefined();
    expect(s.failures.some((f) => f.reason.startsWith("area_mismatch"))).toBe(true);

    // 第三者サイトは企業のサイトとして保存しない
    const sites = await db.select({ url: websites.normalizedUrl }).from(websites);
    expect(sites.map((w) => w.url).sort()).toEqual([
      "https://kakuu-kenchiku.example.jp",
      "https://kakuu-koumuten.example.jp",
    ]);
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
    expect(await db.select().from(companies)).toHaveLength(3);
    expect(await byName("株式会社架空工務店")).toMatchObject({ suppression: "do_not_contact" });
    expect(s.failures.some((f) => f.reason === "suppressed: do_not_contact")).toBe(true);
  });
});
