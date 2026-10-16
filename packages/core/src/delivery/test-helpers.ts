// テスト専用の準備関数。index.ts からは export しない（apps/web の顧客画面のテストからも使う）
import { createHash, randomUUID } from "node:crypto";
import {
  assignments,
  companies,
  contracts,
  type Db,
  designVersions,
  proposals,
  proposalVersions,
  siteAudits,
  users,
  websites,
} from "@siteoffer/db";
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
  const [website] = await db
    .insert(websites)
    .values({
      companyId: company!.id,
      url: `https://fixture-${seq}.example.test`,
      normalizedUrl: `fixture-${seq}.example.test`,
      domain: `fixture-${seq}.example.test`,
    })
    .returning();
  const [audit] = await db
    .insert(siteAudits)
    .values({ companyId: company!.id, websiteId: website!.id, targetUrl: website!.url, status: "evaluated" })
    .returning();
  const [proposal] = await db.insert(proposals).values({ companyId: company!.id }).returning();
  const bytes = Buffer.from("fixture-design");
  const [design] = await db
    .insert(designVersions)
    .values({
      companyId: company!.id,
      auditId: audit!.id,
      version: 1,
      requestKey: randomUUID(),
      status: "approved",
      buildRequestedAt: new Date("2026-10-02T00:00:00Z"),
      brief: {},
      companySnapshot: {},
      prompt: "fixture",
      source: "import",
      imageBase64: bytes.toString("base64"),
      imageSha256: createHash("sha256").update(bytes).digest("hex"),
    })
    .returning();
  const [proposalVersion] = await db
    .insert(proposalVersions)
    .values({
      proposalId: proposal!.id,
      version: 1,
      status: "approved",
      auditId: audit!.id,
      content: { designVersionId: design!.id },
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
      proposalVersionId: proposalVersion!.id,
      snapshot: { version: 1, terms: { scope: { description: "架空の会社案内2ページ" } } },
      reportedAt: new Date("2026-10-02T00:00:00Z"),
      completedAt: status === "completed" ? new Date("2026-10-03T00:00:00Z") : null,
    })
    .returning();
  return {
    sales,
    ops,
    company: company!,
    contract: contract!,
    audit: audit!,
    proposalVersion: proposalVersion!,
    design: design!,
  };
}
