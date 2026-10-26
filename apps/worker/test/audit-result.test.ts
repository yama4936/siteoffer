import { recordEvent } from "@siteoffer/core";
import {
  auditEvents,
  companies,
  findings,
  generationJobs,
  proposalHandoffs,
  siteAudits,
  websites,
} from "@siteoffer/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resumeSavedAudit } from "../src/audit-result.ts";
import { QUEUES, stepKeys } from "../src/queues.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

let e: TestEnv;
beforeEach(async () => {
  e = await setupEnv({ threshold: 100 });
});
afterEach(async () => {
  await e.cleanup();
});
async function seed(saved = true) {
  const [company] = await e.db
    .insert(companies)
    .values({ name: "診断結果再利用試験", officialSiteStatus: "confirmed", pipelineStatus: "site_confirmed" })
    .returning();
  const [site] = await e.db
    .insert(websites)
    .values({
      companyId: company!.id,
      url: "https://reuse.example/",
      normalizedUrl: `https://${company!.id}.example/`,
      domain: "reuse.example",
      kind: "current",
      isPrimary: true,
    })
    .returning();
  const payload = { companyId: company!.id, requestKey: "resume" };
  if (!saved) return { company: company!, site: site!, payload, audit: undefined };
  const [audit] = await e.db
    .insert(siteAudits)
    .values({
      companyId: company!.id,
      websiteId: site!.id,
      targetUrl: site!.url,
      status: "evaluated",
      decision: "create",
    })
    .returning();
  await recordEvent(e.db, e.clock, {
    actor: { kind: "system", job: "fixture" },
    action: "site_audit.started",
    targetType: "site_audit",
    targetId: audit!.id,
    after: { workerStepKey: stepKeys.audit(payload), workerAttempt: 1 },
  });
  return { company: company!, site: site!, payload, audit: audit! };
}
describe("保存済み診断からの再開", () => {
  it("診断確定後の引き継ぎ保存が失敗しても、次の試行は再取得・再採点せず同じ結果を使う", async () => {
    const s = await seed(false);
    await e.db.execute(
      sql`create function reject_apply() returns trigger language plpgsql as $$ begin if NEW.action = 'pipeline.audit_result_applied' then raise exception 'injected result apply failure'; end if; return NEW; end $$`,
    );
    await e.db.execute(
      sql`create trigger reject_apply before insert on audit_events for each row execute function reject_apply()`,
    );
    expect(await e.runtime.run(QUEUES.audit, s.payload)).toMatchObject({ status: "retry" });
    const [audit] = await e.db.select().from(siteAudits);
    expect(audit).toMatchObject({ status: "evaluated", decision: "create" });
    const facts = await e.db.select().from(findings);
    expect(facts.length).toBeGreaterThan(0);
    expect(await e.db.select().from(proposalHandoffs)).toHaveLength(0);
    expect((await e.db.select().from(companies))[0]!.pipelineStatus).toBe("site_confirmed");
    const calls = e.generator.calls.length;
    expect(calls).toBe(1);
    await e.db.execute(sql`drop trigger reject_apply on audit_events`);
    e.deps.audit.collector = {
      async collect() {
        throw Error("must not collect again");
      },
    };
    expect(await e.runtime.run(QUEUES.audit, s.payload)).toMatchObject({
      status: "succeeded",
      attempt: 2,
      result: { auditId: audit!.id, proposalQueued: true },
    });
    expect(e.generator.calls).toHaveLength(calls);
    expect(await e.db.select().from(generationJobs)).toHaveLength(1);
    expect(await e.db.select().from(siteAudits)).toHaveLength(1);
    expect(await e.db.select().from(findings)).toEqual(facts);
    expect(await e.db.select().from(proposalHandoffs)).toHaveLength(1);
    expect(e.queue.size).toBe(1);
    expect(
      (await e.db.select().from(auditEvents).where(eq(auditEvents.action, "pipeline.audit_result_applied")))[0]!.after,
    ).toMatchObject({ reused: true, auditId: audit!.id });
  });
  it.each([
    ["evaluated", "create", "audited", true],
    ["evaluated", "hold", "on_hold", false],
    ["evaluated", "skip", "audited", false],
    ["unevaluable", "hold", "on_hold", false],
  ] as const)("%s/%sを保存済みの判定のまま一度だけ適用する", async (status, decision, companyStatus, queued) => {
    const s = await seed();
    await e.db.update(siteAudits).set({ status, decision });
    expect(await e.runtime.run(QUEUES.audit, s.payload)).toMatchObject({
      status: "succeeded",
      result: { auditId: s.audit!.id, auditStatus: status, decision, proposalQueued: queued },
    });
    expect(e.generator.calls).toHaveLength(0);
    expect((await e.db.select().from(companies))[0]!.pipelineStatus).toBe(companyStatus);
    await e.db.update(companies).set({ pipelineStatus: "in_review" });
    await e.db.transaction((tx) => resumeSavedAudit(tx, e.clock, s.payload));
    expect((await e.db.select().from(companies))[0]!.pipelineStatus).toBe("in_review");
    expect(
      await e.db.select().from(auditEvents).where(eq(auditEvents.action, "pipeline.audit_result_applied")),
    ).toHaveLength(1);
    expect(await e.db.select().from(proposalHandoffs)).toHaveLength(queued ? 1 : 0);
  });
  it.each(["different-request", "different-url", "different-site", "failed", "foreign-company"])(
    "%sの結果は再利用しない",
    async (kind) => {
      const s = await seed();
      if (kind === "different-request") s.payload.requestKey = "fresh-request";
      if (kind === "different-url") await e.db.update(websites).set({ url: "https://new.example/" });
      if (kind === "different-site") {
        await e.db.update(websites).set({ isPrimary: false });
        await e.db.insert(websites).values({
          companyId: s.company.id,
          url: s.site.url,
          normalizedUrl: "https://other.example/",
          domain: "reuse.example",
          isPrimary: true,
          kind: "current",
        });
      }
      if (kind === "failed") await e.db.update(siteAudits).set({ status: "failed" });
      if (kind === "foreign-company") {
        const [other] = await e.db.insert(companies).values({ name: "別企業" }).returning();
        await e.db.update(siteAudits).set({ companyId: other!.id });
      }
      expect(await e.db.transaction((tx) => resumeSavedAudit(tx, e.clock, s.payload))).toBeNull();
      expect(await e.db.select().from(proposalHandoffs)).toHaveLength(0);
      expect(e.generator.calls).toHaveLength(0);
    },
  );
  it.each(["suppressed", "unconfirmed"])("保存後に%sとなった企業を制作へ送らない", async (kind) => {
    const s = await seed();
    await e.db
      .update(companies)
      .set(kind === "suppressed" ? { suppression: "do_not_contact" } : { officialSiteStatus: "needs_review" });
    const result = await e.db.transaction((tx) => resumeSavedAudit(tx, e.clock, s.payload));
    expect(result?.skipped).toBeTruthy();
    expect(result?.proposalQueued).toBe(false);
    expect(await e.db.select().from(proposalHandoffs)).toHaveLength(0);
    expect((await e.db.select().from(companies))[0]!.pipelineStatus).toBe("site_confirmed");
  });
});
