import { randomUUID } from "node:crypto";
import { fixedClock } from "@siteoffer/core";
import {
  assignments,
  auditRequests,
  companies,
  contracts,
  type Db,
  deliveries,
  designVersions,
  proposalHandoffs,
  proposalVersions,
  users,
  websites,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { seedDeliveryBase } from "../../../../packages/core/src/delivery/test-helpers.ts";
import { getCompanyJourney } from "./company-journey";
import { type CompanyJourneyFacts, companyJourneyState } from "./company-journey-state";
import { seedCandidate, seedUser } from "./test-seed";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-18T09:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
function value<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw Error(result.error);
  return result.value;
}
const empty = (): CompanyJourneyFacts => ({
  company: { id: randomUUID(), officialSiteStatus: "not_found", pipelineStatus: "collected", suppression: "none" },
  siteUsable: false,
  audit: null,
  request: null,
  design: null,
  proposal: null,
  handoff: false,
  pipelinePending: false,
  offer: false,
  assignment: null,
  contract: null,
  delivery: null,
  checkedAt: clock.now().toISOString(),
});

it("shows missing evidence independently and does not infer completed steps from the company pipeline flag", () => {
  const f = empty(),
    initial = companyJourneyState(f);
  expect(initial.next.key).toBe("site");
  expect(initial.cards.filter((card) => card.value === "記録なし")).toHaveLength(5);
  expect(initial.documents).toEqual({ design: null, proposal: null });
  const broken = companyJourneyState({ ...f, company: { ...f.company, pipelineStatus: "sellable" } });
  expect(broken.next.key).toBe("records");
  expect(broken.cards.find((card) => card.key === "proposal")?.value).toBe("記録なし");
  expect(
    companyJourneyState({
      ...f,
      company: { ...f.company, pipelineStatus: "in_review" },
      audit: { id: randomUUID(), status: "evaluated", decision: "create" },
    }).next.key,
  ).toBe("records");
});
it.each(["queued", "collecting", "scoring", "evaluated", "unevaluable", "failed"] as const)(
  "uses the actual %s diagnosis state and keeps hold/skip separate from eligible creation",
  (status) => {
    const f = empty(),
      audit = { id: randomUUID(), status, decision: "hold" as const };
    const current = companyJourneyState({ ...f, audit });
    expect(current.next.key).toBe("audit");
    expect(current.next.waiting).toBe(["queued", "collecting", "scoring"].includes(status));
    if (status === "evaluated") {
      expect(current.next.description).toContain("保留");
      const create = companyJourneyState({ ...f, audit: { ...audit, decision: "create" } });
      expect(create.next.key).toBe("design");
      expect(new URL(create.next.href, "http://local").searchParams.get("audit")).toBe(audit.id);
      expect(companyJourneyState({ ...f, audit: { ...audit, decision: "skip" } }).next.description).toContain(
        "作成しない",
      );
    }
  },
);
it.each(["draft", "queued", "generating", "in_review", "approved", "rejected", "failed"] as const)(
  "pins the exact latest design in %s and links only stored-image PDFs",
  (status) => {
    const f = empty(),
      design = {
        id: randomUUID(),
        auditId: randomUUID(),
        version: 501,
        status,
        hasImage: false,
        buildRequested: false,
      };
    const current = companyJourneyState({ ...f, design });
    expect(current.next.key).toBe("design");
    const url = new URL(current.next.href, "http://local");
    expect(url.searchParams.get("design")).toBe(design.id);
    expect(url.searchParams.get("audit")).toBe(design.auditId);
    expect(current.documents.design).toBeNull();
    if (status === "failed" || status === "rejected")
      expect(companyJourneyState({ ...f, design: { ...design, buildRequested: true } }).next.waiting).toBe(false);
    expect(companyJourneyState({ ...f, design: { ...design, hasImage: true } }).documents.design).toBe(
      `/ops/designs/${design.id}/pdf`,
    );
  },
);
it.each(["generating", "in_review", "approved", "rejected", "failed"] as const)(
  "preserves the current proposal in %s rather than sending it back to the first diagnosis",
  (status) => {
    const f = empty(),
      proposal = { id: randomUUID(), version: 13, status, hasDocument: false };
    const current = companyJourneyState({ ...f, proposal });
    expect(current.next.key).toBe(status === "approved" ? "sales" : "proposal");
    expect(current.documents.proposal).toBeNull();
    if (["in_review", "rejected", "failed"].includes(status))
      expect(new URL(current.next.href, "http://local").searchParams.get("version")).toBe(proposal.id);
  },
);
it("keeps protected sales suppressed while continuing an existing contract and never equates reported contracts with completed publication", () => {
  const f = empty(),
    contract = { id: randomUUID(), status: "reported" as const };
  const suppressed = { ...f, company: { ...f.company, suppression: "do_not_contact" as const } };
  expect(companyJourneyState(suppressed).next.key).toBe("suppression");
  const reported = companyJourneyState({ ...suppressed, contract });
  expect(reported.next.key).toBe("contract");
  expect(reported.next.href).toBe(`/ops/contracts?focus=${contract.id}`);
  expect(reported.notice).toContain("営業抑止");
  const complete = companyJourneyState({ ...suppressed, contract: { ...contract, status: "completed" } });
  expect(complete.next.key).toBe("delivery");
  expect(complete.cards.find((card) => card.key === "delivery")?.value).toBe("記録なし");
});
it("reads only current metadata, authorizes active ops, and refuses unrelated or nonexistent IDs", async () => {
  const s = await seedDeliveryBase(db),
    sales = await seedUser(db, "sales");
  for (const actor of [
    null,
    sales.actor,
    { kind: "ops" as const, userId: sales.user.id },
    { kind: "ops" as const, userId: randomUUID() },
  ])
    expect(await getCompanyJourney(db, clock, actor, s.company.id)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await getCompanyJourney(db, clock, s.ops, randomUUID())).toMatchObject({ ok: false, error: "not_found" });
  expect(await getCompanyJourney(db, clock, s.ops, "invalid")).toMatchObject({ ok: false, error: "not_found" });
  const current = value(await getCompanyJourney(db, clock, s.ops, s.company.id));
  expect(current.next.key).toBe("delivery");
  expect(current.documents.proposal).toBeNull();
  const serialized = JSON.stringify(current);
  expect(serialized).not.toContain("imageBase64");
  expect(serialized).not.toContain("companySnapshot");
  expect(serialized).not.toContain("snapshot");
  expect(serialized.length).toBeLessThan(6500);
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  expect(await getCompanyJourney(db, clock, s.ops, s.company.id)).toMatchObject({ ok: false, error: "forbidden" });
});
it("resolves the exact proposal PDF source even when a newer unapproved design exists, excluding mismatched hashes, audits or companies", async () => {
  const s = await seedDeliveryBase(db),
    read = async () => value(await getCompanyJourney(db, clock, s.ops, s.company.id));
  const content = { designVersionId: s.design.id, designSha256: s.design.imageSha256 };
  await db.update(proposalVersions).set({ content }).where(eq(proposalVersions.id, s.proposalVersion.id));
  await db.insert(designVersions).values({
    companyId: s.company.id,
    auditId: s.audit.id,
    version: 501,
    requestKey: randomUUID(),
    status: "draft",
    source: "import",
    brief: { text: "private".repeat(10000) },
    companySnapshot: { secret: "private" },
    prompt: "private prompt".repeat(10000),
    imageBase64: "x".repeat(500000),
  });
  expect((await read()).documents.proposal).toBe(`/ops/proposals/${s.proposalVersion.id}/pdf`);
  expect((await read()).documents.design).toBeNull();
  expect(JSON.stringify(await read())).not.toContain("private");
  for (const next of [
    { ...content, designSha256: "mismatch" },
    { designVersionId: s.design.id },
    { ...content, designVersionId: `${s.design.id}x` },
  ]) {
    await db.update(proposalVersions).set({ content: next }).where(eq(proposalVersions.id, s.proposalVersion.id));
    expect((await read()).documents.proposal).toBeNull();
  }
  const other = await seedDeliveryBase(db);
  await db
    .update(proposalVersions)
    .set({ content: { designVersionId: other.design.id, designSha256: other.design.imageSha256 } })
    .where(eq(proposalVersions.id, s.proposalVersion.id));
  expect((await read()).documents.proposal).toBeNull();
  await db
    .update(proposalVersions)
    .set({ content, auditId: other.audit.id })
    .where(eq(proposalVersions.id, s.proposalVersion.id));
  expect((await read()).documents.proposal).toBeNull();
});
it("uses current primary site, explicit diagnosis receipts and pending handoffs before suggesting a duplicate request", async () => {
  const { actor } = await seedUser(db, "ops"),
    s = await seedCandidate(db, { versionStatus: null });
  await db
    .update(companies)
    .set({ pipelineStatus: "site_confirmed", officialSiteStatus: "confirmed" })
    .where(eq(companies.id, s.company.id));
  // Existing diagnosis is held; a pending receipt and handoff override only this unstarted stage.
  const read = async () => value(await getCompanyJourney(db, clock, actor, s.company.id));
  expect((await read()).next.key).toBe("audit");
  await db
    .insert(auditRequests)
    .values({ id: randomUUID(), companyId: s.company.id, websiteId: s.website.id, targetUrl: s.website.url });
  expect((await read()).next.waiting).toBe(true);
  await db
    .insert(proposalHandoffs)
    .values({ sourceStepKey: randomUUID(), companyId: s.company.id, auditId: s.audit.id });
  expect((await read()).next.key).toBe("handoff");
  await db.update(websites).set({ url: "http://127.0.0.1/private" }).where(eq(websites.id, s.website.id));
  expect((await read()).cards.find((card) => card.key === "site")?.value).toBe("対象URLを確認");
});
it("prioritizes a current sales assignment with an expired deadline and a completed contract's actual delivery", async () => {
  const s = await seedDeliveryBase(db, { contractStatus: "cancelled" });
  await db
    .update(assignments)
    .set({ status: "working", expiresAt: new Date("2026-01-01") })
    .where(eq(assignments.companyId, s.company.id));
  let current = value(await getCompanyJourney(db, clock, s.ops, s.company.id));
  expect(current.next.key).toBe("assignment");
  expect(current.next.description).toContain("期限を過ぎ");
  await db.update(contracts).set({ status: "completed" }).where(eq(contracts.id, s.contract.id));
  const [delivery] = await db.insert(deliveries).values({ contractId: s.contract.id, status: "published" }).returning();
  await db.update(companies).set({ suppression: "existing_customer" }).where(eq(companies.id, s.company.id));
  current = value(await getCompanyJourney(db, clock, s.ops, s.company.id));
  expect(current.next.key).toBe("delivery");
  expect(current.next.href).toBe(`/ops/delivery?focus=${delivery!.id}`);
  expect(current.notice).toContain("既存顧客");
  expect(current.cards.find((card) => card.key === "delivery")?.value).toContain("公開");
});
it("detects a handed-off queue job without loading payloads and excludes completed jobs and other companies", async () => {
  const { actor } = await seedUser(db, "ops"),
    s = await seedCandidate(db, { versionStatus: null });
  await db.update(companies).set({ pipelineStatus: "audited" }).where(eq(companies.id, s.company.id));
  await db.execute(sql`create schema pgboss`);
  await db.execute(sql`create table pgboss.job (name text, data jsonb, state text)`);
  await db.execute(
    sql`insert into pgboss.job values ('pipeline.proposal',${JSON.stringify({ companyId: s.company.id, private: "hidden" })}::jsonb,'created'),('pipeline.audit',${JSON.stringify({ companyId: randomUUID() })}::jsonb,'active')`,
  );
  let current = value(await getCompanyJourney(db, clock, actor, s.company.id));
  expect(current.next.key).toBe("pipeline");
  expect(current.next.waiting).toBe(true);
  expect(JSON.stringify(current)).not.toContain("hidden");
  await db.execute(sql`update pgboss.job set state='completed' where data->>'companyId'=${s.company.id}`);
  current = value(await getCompanyJourney(db, clock, actor, s.company.id));
  expect(current.next.key).toBe("audit");
  expect(current.next.waiting).toBe(false);
});
