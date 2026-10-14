// テスト専用のデータ作成。製品コードからは import しない。
// 金額・報酬条件はテスト内だけの値で、仕様の値ではない。
import { assignments, companies, type Db, productTerms, proposals, proposalVersions, users } from "@siteoffer/db";
import type { Actor } from "../common/actor.ts";

let seq = 0;

export async function seedUser(db: Db, role: "sales" | "ops") {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({ email: `${role}${seq}@example.test`, passwordHash: "x", displayName: `${role}-${seq}`, role })
    .returning();
  return u!;
}

export async function seedBase(db: Db) {
  const sales = await seedUser(db, "sales");
  const otherSales = await seedUser(db, "sales");
  const ops = await seedUser(db, "ops");
  const [company] = await db.insert(companies).values({ name: "架空工務店（テスト）" }).returning();
  const [assignment] = await db
    .insert(assignments)
    .values({ companyId: company!.id, userId: sales.id, status: "negotiating", claimedAt: new Date("2026-10-01") })
    .returning();
  const [proposal] = await db.insert(proposals).values({ companyId: company!.id }).returning();
  const [pv] = await db
    .insert(proposalVersions)
    .values({ proposalId: proposal!.id, version: 1, status: "approved" })
    .returning();
  return {
    sales,
    otherSales,
    ops,
    company: company!,
    assignment: assignment!,
    proposalVersion: pv!,
    salesActor: { kind: "sales", userId: sales.id } as Actor,
    otherSalesActor: { kind: "sales", userId: otherSales.id } as Actor,
    opsActor: { kind: "ops", userId: ops.id } as Actor,
  };
}

export async function seedTerms(
  db: Db,
  values: { version: string; price: number | null; rewardRule: unknown; monthlyFee?: number | null },
) {
  const [t] = await db
    .insert(productTerms)
    .values({
      version: values.version,
      name: `テスト条件 ${values.version}`,
      scope: { pages: ["top", "about"] },
      price: values.price,
      monthlyFee: values.monthlyFee ?? null,
      rewardRule: values.rewardRule,
    })
    .returning();
  return t!;
}
