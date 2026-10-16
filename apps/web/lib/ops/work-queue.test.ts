import { randomUUID } from "node:crypto";
import {
  assignments,
  companies,
  contracts,
  type Db,
  deliveries,
  designVersions,
  discoveryJobs,
  proposalVersions,
  siteAudits,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listDeliveryDetails } from "./delivery";
import { listAssignmentsOverview, listContractsOverview } from "./queries";
import { seedCandidate, seedUser } from "./test-seed";
import { getOpsWorkQueue } from "./work-queue";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
async function queue() {
  const { actor } = await seedUser(db, "ops");
  const r = await getOpsWorkQueue(db, actor);
  if (!r.ok) throw new Error("queue");
  return r.value;
}
async function design(
  companyId: string,
  auditId: string,
  version: number,
  status: "draft" | "in_review" | "approved" | "failed" | "queued" = "draft",
) {
  const [row] = await db
    .insert(designVersions)
    .values({
      companyId,
      auditId,
      version,
      status,
      requestKey: randomUUID(),
      brief: {},
      companySnapshot: {},
      prompt: "fixture",
      source: "import",
      imageBase64: "fixture-image-private",
    })
    .returning();
  return row!;
}
it("operations data is rejected before querying for non-operators", async () => {
  expect(await getOpsWorkQueue(db, null)).toMatchObject({ ok: false, error: "forbidden" });
  const { actor } = await seedUser(db, "sales");
  expect(await getOpsWorkQueue(db, actor)).toMatchObject({ ok: false, error: "forbidden" });
});
it("a retry chain only exposes the unresolved leaf; historical failures are not counted", async () => {
  const [old] = await db
    .insert(discoveryJobs)
    .values({ provider: "fixture", criteria: {}, status: "failed" })
    .returning();
  const [retry] = await db
    .insert(discoveryJobs)
    .values({ provider: "fixture", criteria: {}, status: "queued", retryOfJobId: old!.id })
    .returning();
  expect((await queue()).items).toEqual([]);
  await db.update(discoveryJobs).set({ status: "failed" }).where(eq(discoveryJobs.id, retry!.id));
  const q = await queue();
  expect(q.total).toBe(1);
  expect(q.items[0]?.id).toBe(retry!.id);
});
it("only latest actionable design versions are visible; in-flight and suppressed work is excluded", async () => {
  const c = await seedCandidate(db, { versionStatus: null });
  await design(c.company.id, c.audit.id, 1, "failed");
  const latest = await design(c.company.id, c.audit.id, 2, "approved");
  const q = await queue();
  expect(q.items).toHaveLength(1);
  expect(q.items[0]).toMatchObject({ id: latest.id, action: "制作へ進む" });
  expect(JSON.stringify(q)).not.toContain("fixture-image-private");
  await db.update(designVersions).set({ buildRequestedAt: new Date() }).where(eq(designVersions.id, latest.id));
  expect((await queue()).items).toHaveLength(0);
  await design(c.company.id, c.audit.id, 3, "queued");
  expect((await queue()).items).toHaveLength(0);
  await design(c.company.id, c.audit.id, 4, "in_review");
  await db.update(companies).set({ suppression: "do_not_contact" }).where(eq(companies.id, c.company.id));
  expect((await queue()).items).toHaveLength(0);
});
it("superseded proposal reviews disappear and preparation only includes eligible companies", async () => {
  const c = await seedCandidate(db);
  expect((await queue()).items.some((i) => i.id === c.version!.id)).toBe(true);
  await db
    .insert(proposalVersions)
    .values({ proposalId: c.proposal.id, version: 2, status: "approved", auditId: c.audit.id });
  expect((await queue()).items).toHaveLength(0);
  await db.update(companies).set({ pipelineStatus: "audited" }).where(eq(companies.id, c.company.id));
  expect((await queue()).items).toHaveLength(0);
  await db.update(siteAudits).set({ decision: "create" }).where(eq(siteAudits.id, c.audit.id));
  expect((await queue()).items[0]).toMatchObject({ group: "preparation", title: c.company.name });
  await design(c.company.id, c.audit.id, 1);
  expect((await queue()).items.map((i) => i.group)).toEqual(["design"]);
});
it("counts include all rows beyond the display limit and stopped work comes first", async () => {
  await db.insert(discoveryJobs).values(
    Array.from({ length: 24 }, (_, i) => ({
      provider: "fixture",
      criteria: {},
      status: "failed" as const,
      createdAt: new Date(2026, 0, 1 + i),
    })),
  );
  const q = await queue();
  expect(q.total).toBe(24);
  expect(q.groups.find((g) => g.key === "discovery")?.count).toBe(24);
  expect(q.items).toHaveLength(20);
  expect(q.items[0]?.since).toBe(new Date(2026, 0, 1).toISOString());
});
it("focused handoff links return precisely the requested assignment, contract and delivery", async () => {
  const { actor: ops } = await seedUser(db, "ops");
  const { user } = await seedUser(db, "sales");
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const c = await seedCandidate(db, { versionStatus: null });
    const [a] = await db
      .insert(assignments)
      .values({ companyId: c.company.id, userId: user.id, status: "awaiting_ops", claimedAt: new Date() })
      .returning();
    const [contract] = await db
      .insert(contracts)
      .values({
        companyId: c.company.id,
        assignmentId: a!.id,
        salesUserId: user.id,
        status: "completed",
        reportedAt: new Date(),
      })
      .returning();
    const [d] = await db.insert(deliveries).values({ contractId: contract!.id, status: "ops_review" }).returning();
    ids.push({ a: a!.id, c: contract!.id, d: d!.id });
  }
  const id = ids[0]!;
  const a = await listAssignmentsOverview(db, ops, { id: id.a });
  expect(a.ok && a.value.map((r) => r.a.id)).toEqual([id.a]);
  const c = await listContractsOverview(db, ops, { id: id.c });
  expect(c.ok && c.value.map((r) => r.c.id)).toEqual([id.c]);
  const d = await listDeliveryDetails(db, ops, { id: id.d });
  expect(d.ok && d.value.map((r) => r.delivery.id)).toEqual([id.d]);
  const q = await queue();
  expect(q.items.find((i) => i.id === id.d)?.href).toContain(`?focus=${id.d}#delivery-${id.d}`);
  const { actor: sales } = await seedUser(db, "sales");
  expect(await listDeliveryDetails(db, sales, { id: id.d })).toMatchObject({ ok: false, error: "forbidden" });
});
