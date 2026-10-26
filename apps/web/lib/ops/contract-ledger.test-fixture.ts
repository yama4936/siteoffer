// Test-only relational fixture shared by unit and real PostgreSQL checks.
import { randomUUID } from "node:crypto";
import { assignments, companies, contracts, type Db, payments, rewardAdjustments, rewards, users } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import { seedUser } from "./test-seed";

const now = new Date("2026-10-18T00:00:00Z");
export async function seedContractLedgerFixture(db: Db) {
  const operator = await seedUser(db, "ops"),
    a = await seedUser(db, "sales"),
    b = await seedUser(db, "sales");
  const ops = operator.actor;
  const sales = a.actor;
  await db.update(users).set({ displayName: "営業甲" }).where(eq(users.id, a.user.id));
  await db.update(users).set({ displayName: "営業乙" }).where(eq(users.id, b.user.id));
  const cs = await db
    .insert(companies)
    .values(
      Array.from({ length: 240 }, (_, i) => ({
        id: randomUUID(),
        name: i === 239 ? "全件検索の目印%_\\記号" : `架空契約企業${i}`,
      })),
    )
    .returning();
  const statuses = ["reported", "under_review", "completed", "rejected", "cancelled"] as const;
  const assignmentRows = await db
    .insert(assignments)
    .values(
      cs.map((c, i) => ({
        companyId: c.id,
        userId: i % 2 ? b.user.id : a.user.id,
        status:
          statuses[i % 5] === "completed"
            ? ("completed" as const)
            : statuses[i % 5] === "reported" || statuses[i % 5] === "under_review"
              ? ("contract_pending" as const)
              : ("lost" as const),
        claimedAt: new Date("2026-10-01T00:00:00Z"),
      })),
    )
    .returning();
  const records = await db
    .insert(contracts)
    .values(
      assignmentRows.map((assignment, i) => ({
        companyId: assignment.companyId,
        assignmentId: assignment.id,
        salesUserId: assignment.userId,
        status: statuses[i % 5]!,
        reportedAt: i === 239 ? new Date("2000-01-01T00:00:00Z") : i < 80 ? now : new Date(now.getTime() - i * 1000),
        completedAt: statuses[i % 5] === "completed" ? now : null,
        snapshot: statuses[i % 5] === "completed" ? { fixture: true } : null,
      })),
    )
    .returning();
  const completed = records.filter((row) => row.status === "completed");
  const rewardStatuses = ["accrued", "scheduled", "paid", "cancelled"] as const;
  const rws = await db
    .insert(rewards)
    .values(
      completed.map((row, i) => ({
        contractId: row.id,
        userId: row.salesUserId,
        amount: 2000 + i,
        status: rewardStatuses[i % 4]!,
        accruedAt: now,
        scheduledFor: i % 4 === 1 || i % 4 === 2 ? now : null,
        paidAt: i % 4 === 2 ? now : null,
        cancelledAt: i % 4 === 3 ? now : null,
      })),
    )
    .returning();
  await db.insert(payments).values(
    completed.map((row, i) => ({
      contractId: row.id,
      amount: 10000,
      status: (["pending", "received", "refunded", "cancelled"] as const)[i % 4]!,
      recordedBy: operator.user.id,
    })),
  );
  const adjustments = rws.flatMap((row) => [
    {
      rewardId: row.id,
      delta: 100,
      reason: "架空の増額",
      createdBy: operator.user.id,
      createdAt: new Date(now.getTime() + 1),
    },
    {
      rewardId: row.id,
      delta: -25,
      reason: "架空の減額",
      createdBy: operator.user.id,
      createdAt: new Date(now.getTime() + 2),
    },
    ...(row.status === "cancelled"
      ? [
          {
            rewardId: row.id,
            delta: -(row.amount + 75),
            reason: "架空の取消",
            createdBy: operator.user.id,
            createdAt: new Date(now.getTime() + 3),
            kind: "cancellation" as const,
          },
        ]
      : []),
  ]);
  await db.insert(rewardAdjustments).values(adjustments);
  return { ops, sales, records };
}
