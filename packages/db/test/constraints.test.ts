import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.ts";
import { assignments, companies, contracts, generationJobs, rewards, users, websites } from "../src/schema/index.ts";
import { createTestDb } from "../src/testing.ts";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

async function seed() {
  const [sales1] = await db
    .insert(users)
    .values({ email: "a@example.test", passwordHash: "x", displayName: "A", role: "sales" })
    .returning();
  const [sales2] = await db
    .insert(users)
    .values({ email: "b@example.test", passwordHash: "x", displayName: "B", role: "sales" })
    .returning();
  const [company] = await db.insert(companies).values({ name: "架空工務店" }).returning();
  return { sales1: sales1!, sales2: sales2!, company: company! };
}

describe("スキーマの一意制約", () => {
  it("同一企業の有効な担当は1件だけ", async () => {
    const { sales1, sales2, company } = await seed();
    const now = new Date();
    await db.insert(assignments).values({ companyId: company.id, userId: sales1.id, claimedAt: now });
    await expect(
      db.insert(assignments).values({ companyId: company.id, userId: sales2.id, claimedAt: now }),
    ).rejects.toThrow();
  });

  it("解除済みの担当は、次の担当の確保を妨げない", async () => {
    const { sales1, sales2, company } = await seed();
    const now = new Date();
    await db
      .insert(assignments)
      .values({ companyId: company.id, userId: sales1.id, claimedAt: now, status: "released", releasedAt: now });
    await db.insert(assignments).values({ companyId: company.id, userId: sales2.id, claimedAt: now });
    const rows = await db.select().from(assignments);
    expect(rows).toHaveLength(2);
  });

  it("報酬は契約ごとに1件だけ", async () => {
    const { sales1, company } = await seed();
    const now = new Date();
    const [a] = await db
      .insert(assignments)
      .values({ companyId: company.id, userId: sales1.id, claimedAt: now })
      .returning();
    const [c] = await db
      .insert(contracts)
      .values({ companyId: company.id, assignmentId: a!.id, salesUserId: sales1.id, reportedAt: now })
      .returning();
    await db.insert(rewards).values({ contractId: c!.id, userId: sales1.id, amount: 1, accruedAt: now });
    await expect(
      db.insert(rewards).values({ contractId: c!.id, userId: sales1.id, amount: 1, accruedAt: now }),
    ).rejects.toThrow();
  });

  it("正規化URLは重複できない", async () => {
    const { company } = await seed();
    const row = {
      companyId: company.id,
      url: "https://example.test/",
      normalizedUrl: "example.test/",
      domain: "example.test",
    };
    await db.insert(websites).values(row);
    await expect(db.insert(websites).values(row)).rejects.toThrow();
  });

  it("生成ジョブの冪等キーは重複できない", async () => {
    const row = { idempotencyKey: "k1", purpose: "proposal_text" as const, generator: "mock", promptVersion: "v1" };
    await db.insert(generationJobs).values(row);
    await expect(db.insert(generationJobs).values(row)).rejects.toThrow();
  });
});
