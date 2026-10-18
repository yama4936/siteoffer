import { randomUUID } from "node:crypto";
import { fixedClock } from "@siteoffer/core";
import { auditEvents, companies, type Db, users, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { getCompanyAuditRequest, requestAuditByOps } from "@siteoffer/worker/audit-request";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { seedUser } from "./test-seed";
import {
  listWebsiteCandidateEvidence,
  reviewOfficialWebsite,
  safeWebsiteCandidateUrl,
  saveWebsiteCandidate,
  websiteReviewFingerprint,
} from "./website-candidate";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-18T09:30:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
async function setup() {
  const { actor } = await seedUser(db, "ops");
  const [company] = await db.insert(companies).values({ name: "候補のない架空企業" }).returning();
  return {
    actor,
    company: company!,
    input: {
      companyId: company!.id,
      requestId: randomUUID(),
      expected: websiteReviewFingerprint(company!),
      url: "https://www.example.test/?utm_source=manual",
      sourceUrl: "https://source.example.test/company",
      note: "会社名と所在地の一致を確認",
      confirmed: true,
    },
  };
}
function value<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw Error(r.error);
  return r.value;
}
it("rejects non-public, credential-bearing, malformed and secret URLs without performing a fetch", () => {
  expect(safeWebsiteCandidateUrl("https://www.example.test/a?utm_source=x")).toMatchObject({
    domain: "example.test",
    normalizedUrl: "https://example.test/a",
  });
  for (const url of [
    "example.test",
    "http://127.0.0.1/",
    "http://localhost/",
    "https://user:pass@example.test/",
    "ftp://example.test/",
    "https://example.test:444/",
    "https://example.test/?token=private",
    "https://example.test/%ZZ",
    "https://example.test/#private",
    "https://example.test/\n",
  ])
    expect(safeWebsiteCandidateUrl(url)).toBeNull();
});
it("adds provenance without automatically confirming the site or replacing an approved primary, and retrying a receipt is idempotent", async () => {
  const s = await setup(),
    first = value(await saveWebsiteCandidate({ db, clock }, s.actor, s.input));
  let [company] = await db.select().from(companies).where(eq(companies.id, s.company.id));
  let [site] = await db.select().from(websites);
  expect(company).toMatchObject({
    officialSiteStatus: "needs_review",
    pipelineStatus: "collected",
    suppression: "none",
  });
  expect(site).toMatchObject({ id: first.websiteId, kind: "current", isPrimary: false });
  expect(await saveWebsiteCandidate({ db, clock }, s.actor, s.input)).toMatchObject({
    ok: true,
    value: { alreadySaved: true },
  });
  expect(
    (await db.select().from(auditEvents)).filter((e) => e.action === "company.website_candidate_saved"),
  ).toHaveLength(1);
  const review = value(
    await reviewOfficialWebsite({ db, clock }, s.actor, {
      companyId: s.company.id,
      status: "confirmed",
      websiteId: site!.id,
      expected: websiteReviewFingerprint(company!, site),
    }),
  );
  expect(review.officialSiteStatus).toBe("confirmed");
  const next = {
    ...s.input,
    requestId: randomUUID(),
    expected: websiteReviewFingerprint(review),
    url: "https://other.example.test/",
  };
  expect((await saveWebsiteCandidate({ db, clock }, s.actor, next)).ok).toBe(true);
  [company] = await db.select().from(companies).where(eq(companies.id, s.company.id));
  [site] = await db.select().from(websites).where(eq(websites.id, first.websiteId));
  expect(company!.officialSiteStatus).toBe("confirmed");
  expect(site!.isPrimary).toBe(true);
  const evidence = value(await listWebsiteCandidateEvidence(db, s.actor, s.company.id));
  expect(evidence).toHaveLength(2);
  expect(evidence[0]!.data).toMatchObject({ sourceUrl: s.input.sourceUrl, note: s.input.note });
});
it("deduplicates normalized URLs and prevents taking another company's or a generated proposal site's URL", async () => {
  const s = await setup();
  const first = value(await saveWebsiteCandidate({ db, clock }, s.actor, s.input));
  const [company] = await db.select().from(companies).where(eq(companies.id, s.company.id));
  expect(
    await saveWebsiteCandidate({ db, clock }, s.actor, {
      ...s.input,
      requestId: randomUUID(),
      expected: websiteReviewFingerprint(company!),
      url: "http://example.test/",
    }),
  ).toMatchObject({ ok: true, value: { websiteId: first.websiteId, created: false } });
  expect(await db.select().from(websites)).toHaveLength(1);
  const other = await setup();
  expect(
    await saveWebsiteCandidate({ db, clock }, other.actor, { ...other.input, url: "https://example.test/" }),
  ).toMatchObject({ ok: false, error: "url_conflict" });
  await db.insert(websites).values({
    companyId: s.company.id,
    url: "https://proposal.example.test/",
    normalizedUrl: "https://proposal.example.test",
    domain: "proposal.example.test",
    kind: "proposal",
  });
  expect(
    await saveWebsiteCandidate({ db, clock }, s.actor, {
      ...s.input,
      requestId: randomUUID(),
      expected: websiteReviewFingerprint(company!),
      url: "https://proposal.example.test/",
    }),
  ).toMatchObject({ ok: false, error: "url_conflict" });
  expect(
    await saveWebsiteCandidate({ db, clock }, s.actor, { ...s.input, note: "操作IDで別の根拠を送信" }),
  ).toMatchObject({ ok: false, error: "operation_reused" });
  await db.insert(websites).values({
    companyId: s.company.id,
    url: "https://name:demo-password@unsafe.example.test/",
    normalizedUrl: "https://unsafe.example.test",
    domain: "unsafe.example.test",
  });
  expect(
    await saveWebsiteCandidate({ db, clock }, s.actor, {
      ...s.input,
      requestId: randomUUID(),
      expected: websiteReviewFingerprint(company!),
      url: "https://unsafe.example.test/",
    }),
  ).toMatchObject({ ok: false, error: "invalid_existing_site" });
  expect(JSON.stringify(await db.select().from(auditEvents))).not.toContain("demo-password");
});
it("rejects stale confirmations and missing or unrelated current sites without discarding existing primary selections", async () => {
  const s = await setup();
  value(await saveWebsiteCandidate({ db, clock }, s.actor, s.input));
  const [company] = await db.select().from(companies).where(eq(companies.id, s.company.id)),
    [site] = await db.select().from(websites);
  expect(
    await reviewOfficialWebsite({ db, clock }, s.actor, {
      companyId: s.company.id,
      status: "confirmed",
      expected: websiteReviewFingerprint(company!),
    }),
  ).toMatchObject({ ok: false, error: "website_required" });
  expect(
    await reviewOfficialWebsite({ db, clock }, s.actor, {
      companyId: s.company.id,
      status: "confirmed",
      websiteId: randomUUID(),
      expected: websiteReviewFingerprint(company!),
    }),
  ).toMatchObject({ ok: false, error: "website_not_found" });
  const expected = websiteReviewFingerprint(company!, site!);
  await db.update(websites).set({ url: "https://changed.example.test/" }).where(eq(websites.id, site!.id));
  expect(
    await reviewOfficialWebsite({ db, clock }, s.actor, {
      companyId: s.company.id,
      status: "confirmed",
      websiteId: site!.id,
      expected,
    }),
  ).toMatchObject({ ok: false, error: "stale" });
  expect(await saveWebsiteCandidate({ db, clock }, s.actor, { ...s.input, requestId: randomUUID() })).toMatchObject({
    ok: false,
    error: "stale",
  });
  expect((await db.select().from(companies))[0]!.officialSiteStatus).toBe("needs_review");
});
it("requires current active ops, explicit confirmation and valid evidence even when replaying a saved receipt", async () => {
  const s = await setup(),
    sales = await seedUser(db, "sales");
  for (const actor of [null, sales.actor, { kind: "ops" as const, userId: sales.user.id }])
    expect(await saveWebsiteCandidate({ db, clock }, actor, s.input)).toMatchObject({ ok: false, error: "forbidden" });
  for (const patch of [
    { confirmed: false },
    { sourceUrl: "" },
    { note: "x" },
    { note: "x".repeat(2001) },
    { requestId: "bad" },
  ])
    expect(await saveWebsiteCandidate({ db, clock }, s.actor, { ...s.input, ...patch })).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  expect(await db.select().from(websites)).toHaveLength(0);
  value(await saveWebsiteCandidate({ db, clock }, s.actor, s.input));
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.actor.userId));
  expect(await saveWebsiteCandidate({ db, clock }, s.actor, s.input)).toMatchObject({ ok: false, error: "forbidden" });
  expect(
    await reviewOfficialWebsite({ db, clock }, s.actor, { companyId: s.company.id, status: "candidate" }),
  ).toMatchObject({ ok: false, error: "forbidden" });
  expect(await listWebsiteCandidateEvidence(db, s.actor, s.company.id)).toMatchObject({
    ok: false,
    error: "forbidden",
  });
});
it("keeps source notes in the operator history, with a bounded latest-20 result and no hidden receipt digests", async () => {
  const s = await setup();
  for (let i = 0; i < 23; i++) {
    const [company] = await db.select().from(companies).where(eq(companies.id, s.company.id));
    expect(
      (
        await saveWebsiteCandidate({ db, clock }, s.actor, {
          ...s.input,
          expected: websiteReviewFingerprint(company!),
          requestId: randomUUID(),
          note: `会社名の一致確認 ${i}`,
        })
      ).ok,
    ).toBe(true);
  }
  const evidence = value(await listWebsiteCandidateEvidence(db, s.actor, s.company.id));
  expect(evidence).toHaveLength(20);
  expect(JSON.stringify(evidence)).not.toContain('"digest"');
  expect(await db.select().from(websites)).toHaveLength(1);
});
it("unblocks the existing diagnosis intake only after a separate site confirmation, without fetching or generating automatically", async () => {
  const s = await setup();
  value(await saveWebsiteCandidate({ db, clock }, s.actor, s.input));
  const pending = value(await getCompanyAuditRequest(db, s.actor, s.company.id));
  expect(pending.blockedReason).toContain("公式サイト");
  expect(pending.request).toBeNull();
  const [company] = await db.select().from(companies).where(eq(companies.id, s.company.id)),
    [site] = await db.select().from(websites);
  value(
    await reviewOfficialWebsite({ db, clock }, s.actor, {
      companyId: company!.id,
      status: "confirmed",
      websiteId: site!.id,
      expected: websiteReviewFingerprint(company!, site!),
    }),
  );
  const ready = value(await getCompanyAuditRequest(db, s.actor, s.company.id));
  expect(ready.targetUrl).toBe(s.input.url);
  expect(ready.blockedReason).toBeNull();
  expect(ready.request).toBeNull();
  expect((await requestAuditByOps(db, clock, s.actor, { companyId: s.company.id, requestId: randomUUID() })).ok).toBe(
    true,
  );
  expect(value(await getCompanyAuditRequest(db, s.actor, s.company.id)).request?.status).toBe("queued");
});
it("preserves an implicit confirmed target despite misleading timestamps and requires review if a legacy confirmed company has no usable current site", async () => {
  const s = await setup();
  await db.update(companies).set({ officialSiteStatus: "confirmed" }).where(eq(companies.id, s.company.id));
  const [old] = await db
    .insert(websites)
    .values({
      companyId: s.company.id,
      url: "https://original.example.test/",
      normalizedUrl: "https://original.example.test",
      domain: "original.example.test",
      createdAt: new Date("2050-01-01"),
    })
    .returning();
  let [company] = await db.select().from(companies).where(eq(companies.id, s.company.id));
  value(
    await saveWebsiteCandidate({ db, clock }, s.actor, { ...s.input, expected: websiteReviewFingerprint(company!) }),
  );
  expect((await db.select().from(websites).where(eq(websites.id, old!.id)))[0]!.isPrimary).toBe(true);
  expect(value(await getCompanyAuditRequest(db, s.actor, s.company.id)).targetUrl).toBe(old!.url);
  const empty = await setup();
  await db.update(companies).set({ officialSiteStatus: "confirmed" }).where(eq(companies.id, empty.company.id));
  [company] = await db.select().from(companies).where(eq(companies.id, empty.company.id));
  value(
    await saveWebsiteCandidate({ db, clock }, empty.actor, {
      ...empty.input,
      url: "https://new.example.test/",
      expected: websiteReviewFingerprint(company!),
    }),
  );
  expect((await db.select().from(companies).where(eq(companies.id, empty.company.id)))[0]!.officialSiteStatus).toBe(
    "needs_review",
  );
  expect(value(await getCompanyAuditRequest(db, empty.actor, empty.company.id)).blockedReason).toContain("公式サイト");
});
