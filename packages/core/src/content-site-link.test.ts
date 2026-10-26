import { randomUUID } from "node:crypto";
import { contracts, type Db, deliveries, deliveryVersions, deployments } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import { publishedSiteHomeUrl } from "./content-published.ts";
import { createDeliveryForContract } from "./delivery/delivery.ts";
import { seedDeliveryBase } from "./delivery/test-helpers.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-19T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
async function fixture() {
  const base = await seedDeliveryBase(db);
  const delivery = await createDeliveryForContract(db, clock, base.ops, base.contract.id);
  if (!delivery.ok) throw Error(delivery.error);
  const [version] = await db
    .insert(deliveryVersions)
    .values({ deliveryId: delivery.value.delivery.id, version: 1 })
    .returning();
  return { ...base, delivery: delivery.value.delivery, version: version! };
}
async function publication(
  f: Awaited<ReturnType<typeof fixture>>,
  url: string | null,
  createdAt = clock.now(),
  status = "recorded",
) {
  const [row] = await db
    .insert(deployments)
    .values({
      deliveryId: f.delivery.id,
      deliveryVersionId: f.version.id,
      environment: "production",
      url,
      status,
      createdAt,
    })
    .returning();
  return row!;
}
it("元サイトや未公開版で代用せず、公開履歴を再制作中も使う", async () => {
  const f = await fixture();
  expect(await publishedSiteHomeUrl(db, f.company.id)).toBeNull();
  await publication(f, "https://published.example.test/company/");
  expect(await publishedSiteHomeUrl(db, f.company.id)).toBe("https://published.example.test/company/");
  await db.update(deliveries).set({ status: "building" }).where(eq(deliveries.id, f.delivery.id));
  await db.insert(deliveryVersions).values({ deliveryId: f.delivery.id, version: 2, artifactDir: "private-new-draft" });
  expect(await publishedSiteHomeUrl(db, f.company.id)).toBe("https://published.example.test/company/");
  await publication(f, "https://new.example.test/", new Date(clock.now().getTime() + 1000));
  expect(await publishedSiteHomeUrl(db, f.company.id)).toBe("https://new.example.test/");
});
it("失敗・別会社の記録を使わず、不整合な最新版から旧URLへ逃がさない", async () => {
  const f = await fixture(),
    other = await fixture();
  await publication(other, "https://other.example.test/");
  expect(await publishedSiteHomeUrl(db, f.company.id)).toBeNull();
  await publication(f, "https://published.example.test/");
  await publication(f, "https://failed.example.test/", new Date(clock.now().getTime() + 1000), "failed");
  expect(await publishedSiteHomeUrl(db, f.company.id)).toBe("https://published.example.test/");
  const latest = await publication(f, "https://invalid-version.example.test/", new Date(clock.now().getTime() + 2000));
  await db.update(deployments).set({ deliveryVersionId: other.version.id }).where(eq(deployments.id, latest.id));
  expect(await publishedSiteHomeUrl(db, f.company.id)).toBeNull();
});
it("認証・不正なURLを出さず、公開URLのパスや検索条件を保持する", async () => {
  const f = await fixture(),
    record = await publication(f, null);
  for (const url of [
    null,
    "",
    "../old",
    "javascript:alert(1)",
    "//example.test",
    "https://user:secret@example.test/",
    "https://example.test/\n",
    " https://example.test/",
    `https://example.test/${"a".repeat(2048)}`,
  ]) {
    await db.update(deployments).set({ url }).where(eq(deployments.id, record.id));
    expect(await publishedSiteHomeUrl(db, f.company.id)).toBeNull();
  }
  for (const url of [
    "https://example.test/会社/",
    "http://localhost:3200/local/",
    "http://127.0.0.1:3200/",
    "https://example.test/index.php?lang=ja#home",
  ]) {
    await db.update(deployments).set({ url }).where(eq(deployments.id, record.id));
    expect(await publishedSiteHomeUrl(db, f.company.id)).toBe(new URL(url).href);
  }
});
it("契約が取り消された会社や不正IDに公開リンクを返さない", async () => {
  const f = await fixture();
  await publication(f, "https://published.example.test/");
  await db.update(contracts).set({ status: "cancelled" }).where(eq(contracts.id, f.contract.id));
  for (const id of [f.company.id, randomUUID(), "invalid"]) expect(await publishedSiteHomeUrl(db, id)).toBeNull();
});
