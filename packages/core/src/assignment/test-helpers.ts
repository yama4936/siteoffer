// テスト専用の準備関数。index.ts からは export しない
import { companies, type Db, productTerms, proposals, proposalVersions, salesOffers, users } from "@siteoffer/db";
import type { Actor } from "../common/actor.ts";

let seq = 0;

export async function createSalesUser(db: Db, opts: { status?: "active" | "suspended" } = {}) {
  seq++;
  const [u] = await db
    .insert(users)
    .values({
      email: `sales${seq}@example.test`,
      passwordHash: "x",
      displayName: `営業${seq}`,
      role: "sales",
      status: opts.status ?? "active",
    })
    .returning();
  return { user: u!, actor: { kind: "sales", userId: u!.id } satisfies Actor as Actor };
}

export async function createOpsUser(db: Db) {
  seq++;
  const [u] = await db
    .insert(users)
    .values({ email: `ops${seq}@example.test`, passwordHash: "x", displayName: `運営${seq}`, role: "ops" })
    .returning();
  return { user: u!, actor: { kind: "ops", userId: u!.id } satisfies Actor as Actor };
}

/** 架空企業。既定は営業可能（sellable）・抑止なし */
export async function createCompany(db: Db, values: Partial<typeof companies.$inferInsert> = {}) {
  seq++;
  const [c] = await db
    .insert(companies)
    .values({ name: `架空工務店${seq}`, pipelineStatus: "sellable", ...values })
    .returning();
  if (c!.pipelineStatus === "sellable") {
    const [t] = await db
      .insert(productTerms)
      .values({
        version: `assignment-${c!.id}`,
        name: "架空検証条件",
        scope: {},
        price: 100000,
        rewardRule: { type: "fixed", amount: 10000 },
      })
      .returning();
    const [p] = await db.insert(proposals).values({ companyId: c!.id }).returning();
    const [v] = await db
      .insert(proposalVersions)
      .values({ proposalId: p!.id, version: 1, status: "approved" })
      .returning();
    await db
      .insert(salesOffers)
      .values({ companyId: c!.id, version: 1, productTermsId: t!.id, proposalVersionId: v!.id });
  }
  return c!;
}
