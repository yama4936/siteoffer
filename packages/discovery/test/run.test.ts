import { DAY, fixedClock } from "@siteoffer/core";
import { auditEvents, companies, type Db, discoveryJobs, discoverySources, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureProvider } from "../src/providers/fixture.ts";
import { MockSearchProvider } from "../src/providers/search.ts";
import type { DiscoveryProvider } from "../src/providers/types.ts";
import { createDiscoveryJob, type DiscoveryProviders, runDiscovery } from "../src/run.ts";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-14T00:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

function providers(over: Partial<DiscoveryProviders> = {}): DiscoveryProviders {
  return { companies: new FixtureProvider(), search: new MockSearchProvider(), ...over };
}

async function run(criteria: unknown, p: DiscoveryProviders = providers()) {
  const job = await createDiscoveryJob(db, clock, { provider: p.companies.name, criteria });
  if (!job.ok) throw new Error(job.error);
  const r = await runDiscovery(db, clock, job.value.jobId, p);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const byName = async (name: string) => db.select().from(companies).where(eq(companies.name, name));

describe("runDiscovery", () => {
  it("名古屋市の候補を出典・所在地・公式サイト確度付きで保存し、ジョブの件数を記録する（AC-01・AC-02）", async () => {
    const s = await run({ prefecture: "愛知県", city: "名古屋市" });
    expect(s).toMatchObject({
      status: "succeeded",
      found: 6,
      created: 6,
      updated: 0,
      skipped: 0,
      failed: 0,
      limit: 50,
    });

    const [kakuseiko] = await byName("株式会社架空精工");
    expect(kakuseiko).toMatchObject({
      corporateNumber: "8180009990001",
      prefecture: "愛知県",
      city: "名古屋市中区",
      addressSourceUrl: "https://directory.example/companies/F001",
      officialSiteStatus: "confirmed",
      pipelineStatus: "collected",
    });
    // 同じ企業の別ドメインは1社に2サイト。主たるサイトは1つ
    const sites = await db.select().from(websites).where(eq(websites.companyId, kakuseiko!.id));
    expect(sites.map((w) => w.normalizedUrl).sort()).toEqual([
      "https://kakuseiko-online.test/shop",
      "https://kakuseiko.test",
    ]);
    expect(sites.filter((w) => w.isPrimary).map((w) => w.domain)).toEqual(["kakuseiko.test"]);

    const status = async (n: string) => (await byName(n))[0]?.officialSiteStatus;
    expect(await status("有限会社ひだまり工務店")).toBe("candidate");
    expect(await status("株式会社みなと設備")).toBe("needs_review");
    expect(await status("株式会社さくら商事")).toBe("needs_review"); // 北区。見つかるのは春日井の同名企業のサイトだけ
    expect(await status("喫茶こもれび")).toBe("confirmed");
    expect(await status("株式会社あおば印刷")).toBe("confirmed");

    // 第三者サイト・同名の別企業のサイトは websites に入れない
    const all = await db.select().from(websites);
    expect(all.map((w) => w.domain)).not.toContain("portal-directory.example");
    expect(all.map((w) => w.domain)).not.toContain("sakura-shoji.test");
    // 追跡用パラメータ付きURLは正規化して保存
    expect(all.find((w) => w.domain === "aoba-print.test")?.normalizedUrl).toBe("https://aoba-print.test");

    const [job] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, s.jobId));
    expect(job).toMatchObject({
      status: "succeeded",
      foundCount: 6,
      createdCount: 6,
      updatedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      maxResults: 50,
      attempts: 1,
    });
    expect(job!.finishedAt).toEqual(clock.now());

    // 出典（企業・サイト）が残っている
    const sources = await db.select().from(discoverySources);
    expect(sources.filter((x) => x.role === "company")).toHaveLength(6);
    expect(sources.some((x) => x.role === "site" && x.sourceUrl?.startsWith("https://search.example/"))).toBe(true);

    const events = await db.select().from(auditEvents);
    expect(events.filter((e) => e.action === "discovery.company_created")).toHaveLength(6);
    expect(events.some((e) => e.action === "discovery.job_succeeded")).toBe(true);
  });

  it("同じ収集を2回流しても企業・サイト・出典が増えない（AC-03）", async () => {
    const criteria = { prefecture: "愛知県" };
    const first = await run(criteria);
    const counts = async () => ({
      companies: (await db.select().from(companies)).length,
      websites: (await db.select().from(websites)).length,
      sources: (await db.select().from(discoverySources)).length,
    });
    const before = await counts();

    clock.advance(DAY);
    const second = await run(criteria);
    expect(second).toMatchObject({ found: first.found, created: 0, updated: 0, skipped: first.found, failed: 0 });
    expect(await counts()).toEqual(before);

    // 同じジョブの再実行でも増えない
    const again = await runDiscovery(db, clock, second.jobId, providers());
    expect(again.ok && again.value.created).toBe(0);
    expect(await counts()).toEqual(before);
    const [job] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, second.jobId));
    expect(job!.attempts).toBe(2);
  });

  it("同名の別企業は1社にまとめず、それぞれの所在地で保存する", async () => {
    await run({ prefecture: "愛知県" });
    const rows = await byName("株式会社さくら商事");
    expect(rows.map((r) => r.city).sort()).toEqual(["名古屋市北区", "春日井市"]);
    const kasugai = rows.find((r) => r.city === "春日井市")!;
    expect(kasugai.officialSiteStatus).toBe("confirmed");
    const sites = await db.select().from(websites).where(eq(websites.companyId, kasugai.id));
    expect(sites.map((w) => w.domain)).toEqual(["sakura-shoji.test"]);
  });

  it("営業拒否・対象外・既存契約先は再収集で状態を戻さず、更新もしない（AC-03）", async () => {
    await run({ prefecture: "愛知県", city: "名古屋市" });
    const set = async (name: string, suppression: "do_not_contact" | "excluded" | "existing_customer") =>
      db
        .update(companies)
        .set({ suppression, suppressionReason: "テスト", officialSiteStatus: "needs_review" })
        .where(eq(companies.name, name));
    await set("株式会社架空精工", "do_not_contact");
    await set("有限会社ひだまり工務店", "excluded");
    await set("株式会社あおば印刷", "existing_customer");

    clock.advance(DAY);
    const s = await run({ prefecture: "愛知県", city: "名古屋市" });
    expect(s.created).toBe(0);
    expect(
      s.failures
        .filter((f) => f.reason.startsWith("suppressed:"))
        .map((f) => f.externalId)
        .sort(),
    ).toEqual(["F001", "F002", "F009"]);
    for (const [name, sup] of [
      ["株式会社架空精工", "do_not_contact"],
      ["有限会社ひだまり工務店", "excluded"],
      ["株式会社あおば印刷", "existing_customer"],
    ] as const) {
      const [row] = await byName(name);
      expect(row).toMatchObject({ suppression: sup, suppressionReason: "テスト", officialSiteStatus: "needs_review" });
    }
  });

  it("「名古屋」を含む別県の企業を名古屋と断定しない", async () => {
    // 地域条件ありなら、出典の所在地（岐阜県）が条件と違うので保存しない
    const s = await run({ prefecture: "愛知県", keywords: ["名古屋"] });
    expect(s.found).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.failures[0]).toMatchObject({ externalId: "F006", stage: "candidate" });
    expect(s.failures[0]!.reason).toContain("岐阜県");
    expect(await byName("株式会社名古屋精密")).toHaveLength(0);

    // 地域条件なしなら、所在地は出典どおり岐阜県で保存する
    await run({ keywords: ["名古屋"] });
    const [row] = await byName("株式会社名古屋精密");
    expect(row).toMatchObject({ prefecture: "岐阜県", city: "岐阜市" });
    expect(row!.city).not.toContain("名古屋");
  });

  it("所在地が不明な候補は不明のまま保存する（AC-02）", async () => {
    await run({ keywords: ["ゆうひ"] });
    const [row] = await byName("合同会社ゆうひ電機");
    expect(row).toMatchObject({ prefecture: null, city: null, address: null, addressSourceUrl: null });
    expect(row!.officialSiteStatus).toBe("not_found");
  });

  it("上限件数を超えて保存せず、上限をジョブに記録する", async () => {
    const s = await run({ prefecture: "愛知県", limit: 3 });
    expect(s).toMatchObject({ found: 3, created: 3, limit: 3 });
    expect(await db.select().from(companies)).toHaveLength(3);
    const [job] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, s.jobId));
    expect(job!.maxResults).toBe(3);

    // 取得元が上限を守らなくても実行側で打ち切る
    const greedy: DiscoveryProvider = {
      name: "greedy",
      discover: async (c, ctx) => new FixtureProvider().discover({ ...c, limit: 1000 }, ctx),
    };
    const s2 = await run({ prefecture: "静岡県", limit: 1 }, providers({ companies: greedy }));
    expect(s2.found).toBeLessThanOrEqual(1);
  });

  it("検索の失敗は理由を記録し、確認待ちにする", async () => {
    const s = await run(
      { prefecture: "愛知県", city: "名古屋市中区" },
      providers({ search: new MockSearchProvider({ failFor: ["株式会社架空精工"] }) }),
    );
    expect(s.created).toBe(1);
    expect(s.failures).toEqual([expect.objectContaining({ externalId: "F001", stage: "search" })]);
    expect((await byName("株式会社架空精工"))[0]!.officialSiteStatus).toBe("needs_review");
  });

  it("取得元の失敗はジョブを failed にして理由を残す", async () => {
    const broken: DiscoveryProvider = {
      name: "broken",
      discover: async () => ({ ok: false, error: "nta_application_id_missing", message: "IDなし" }),
    };
    const s = await run({ prefecture: "愛知県" }, providers({ companies: broken }));
    expect(s.status).toBe("failed");
    const [job] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, s.jobId));
    expect(job).toMatchObject({ status: "failed", error: "IDなし" });
    expect(job!.failures).toEqual([expect.objectContaining({ stage: "provider" })]);
  });

  it("確認済みの公式サイトは、再収集の結果が弱くても下げない", async () => {
    await run({ prefecture: "愛知県", city: "名古屋市中区" });
    clock.advance(DAY);
    await run(
      { prefecture: "愛知県", city: "名古屋市中区" },
      providers({ search: new MockSearchProvider({ results: {} }) }),
    );
    expect((await byName("株式会社架空精工"))[0]!.officialSiteStatus).toBe("confirmed");
  });

  it("ジョブの取得元と違う取得元では実行しない", async () => {
    const job = await createDiscoveryJob(db, clock, { provider: "nta-corporate-number", criteria: {} });
    if (!job.ok) throw new Error(job.error);
    const r = await runDiscovery(db, clock, job.value.jobId, providers());
    expect(r).toMatchObject({ ok: false, error: "provider_mismatch" });
    expect(await createDiscoveryJob(db, clock, { provider: "fixture", criteria: { limit: -1 } })).toMatchObject({
      ok: false,
      error: "invalid_criteria",
    });
  });
});
