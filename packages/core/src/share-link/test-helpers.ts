// テスト専用の準備関数。index.ts からは export しない（apps/preview のテストからも使う）
import {
  assignments,
  companies,
  contracts,
  type Db,
  deliveries,
  deliveryVersions,
  proposals,
  proposalVersions,
  users,
} from "@siteoffer/db";
import { eq } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";

let seq = 0;

export async function seedUser(db: Db, role: "sales" | "ops") {
  seq++;
  const [u] = await db
    .insert(users)
    .values({ email: `link-${role}${seq}@example.test`, passwordHash: "x", displayName: `${role}${seq}`, role })
    .returning();
  return { user: u!, actor: { kind: role, userId: u!.id } as Actor };
}

export async function seedCompany(db: Db, values: Partial<typeof companies.$inferInsert> = {}) {
  seq++;
  const [c] = await db
    .insert(companies)
    .values({ name: `架空工務店${seq}`, pipelineStatus: "sellable", ...values })
    .returning();
  return c!;
}

export async function seedAssignment(db: Db, companyId: string, userId: string, at = new Date("2026-10-01T00:00:00Z")) {
  const [a] = await db.insert(assignments).values({ companyId, userId, status: "working", claimedAt: at }).returning();
  return a!;
}

/** 企業の提案と版を作る。status ごとに1版ずつ */
export async function seedProposalVersion(
  db: Db,
  companyId: string,
  opts: { status?: (typeof proposalVersions.$inferInsert)["status"]; artifactDir?: string | null } = {},
) {
  let [p] = await db.select().from(proposals).where(eq(proposals.companyId, companyId));
  if (!p) [p] = await db.insert(proposals).values({ companyId }).returning();
  seq++;
  const [v] = await db
    .insert(proposalVersions)
    .values({
      proposalId: p!.id,
      version: seq,
      status: opts.status ?? "approved",
      demoArtifactDir: opts.artifactDir === undefined ? null : opts.artifactDir,
    })
    .returning();
  return v!;
}

/** 契約・納品・納品の版を作る */
export async function seedDeliveryVersion(
  db: Db,
  companyId: string,
  assignmentId: string,
  salesUserId: string,
  artifactDir: string | null,
) {
  const [c] = await db
    .insert(contracts)
    .values({ companyId, assignmentId, salesUserId, reportedAt: new Date("2026-10-02T00:00:00Z") })
    .returning();
  const [d] = await db.insert(deliveries).values({ contractId: c!.id }).returning();
  const [v] = await db.insert(deliveryVersions).values({ deliveryId: d!.id, version: 1, artifactDir }).returning();
  return v!;
}
