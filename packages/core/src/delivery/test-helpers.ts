// テスト専用の準備関数。index.ts からは export しない（apps/web の顧客画面のテストからも使う）
import { assignments, companies, contracts, type Db, users } from "@siteoffer/db";
import type { Actor } from "../common/actor.ts";

let seq = 0;

async function seedUser(db: Db, role: "sales" | "ops") {
  seq++;
  const [u] = await db
    .insert(users)
    .values({ email: `delivery-${role}${seq}@example.test`, passwordHash: "x", displayName: `${role}${seq}`, role })
    .returning();
  return { kind: role, userId: u!.id } as Extract<Actor, { kind: "sales" | "ops" }>;
}

/** 営業・運営・企業・担当・契約（status を指定。既定は completed）を作る */
export async function seedDeliveryBase(
  db: Db,
  opts: { contractStatus?: (typeof contracts.$inferInsert)["status"] } = {},
) {
  const sales = await seedUser(db, "sales");
  const ops = await seedUser(db, "ops");
  seq++;
  const [company] = await db
    .insert(companies)
    .values({ name: `架空設計事務所${seq}` })
    .returning();
  const [assignment] = await db
    .insert(assignments)
    .values({
      companyId: company!.id,
      userId: sales.userId,
      status: "completed",
      claimedAt: new Date("2026-10-01T00:00:00Z"),
    })
    .returning();
  const status = opts.contractStatus ?? "completed";
  const [contract] = await db
    .insert(contracts)
    .values({
      companyId: company!.id,
      assignmentId: assignment!.id,
      salesUserId: sales.userId,
      status,
      reportedAt: new Date("2026-10-02T00:00:00Z"),
      completedAt: status === "completed" ? new Date("2026-10-03T00:00:00Z") : null,
    })
    .returning();
  return { sales, ops, company: company!, contract: contract! };
}
