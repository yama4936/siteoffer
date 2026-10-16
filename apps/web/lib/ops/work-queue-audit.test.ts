import { fixedClock, recordEvent } from "@siteoffer/core";
import { auditEvents, companies, type Db, proposalHandoffs, siteAudits, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { resumeAuditByOps } from "@siteoffer/worker/audit-recovery";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { seedCandidate, seedUser } from "./test-seed";
import { getOpsWorkQueue } from "./work-queue";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
async function queue() {
  const { actor } = await seedUser(db, "ops");
  const result = await getOpsWorkQueue(db, actor, clock);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function candidate(recoverable = true) {
  const c = await seedCandidate(db, { versionStatus: null });
  await db
    .update(companies)
    .set({ pipelineStatus: recoverable ? "failed" : "audited", officialSiteStatus: "confirmed" })
    .where(eq(companies.id, c.company.id));
  await db.update(websites).set({ kind: "current", isPrimary: true }).where(eq(websites.id, c.website.id));
  await db
    .update(siteAudits)
    .set({ decision: recoverable ? "hold" : "create" })
    .where(eq(siteAudits.id, c.audit.id));
  const payload = { companyId: c.company.id, requestKey: "dashboard-recovery" };
  const key = `audit:${payload.companyId}:${payload.requestKey}`;
  if (recoverable) {
    const actor = { kind: "system", job: "fixture" } as const;
    await recordEvent(db, clock, {
      actor,
      action: "site_audit.started",
      targetType: "site_audit",
      targetId: c.audit.id,
      after: { workerStepKey: key },
    });
    await recordEvent(db, clock, {
      actor,
      action: "worker.step_started",
      targetType: "worker_step",
      targetId: key,
      after: { queue: "pipeline.audit", attempt: 1, payload },
    });
    await recordEvent(db, clock, {
      actor,
      action: "worker.step_failed",
      targetType: "worker_step",
      targetId: key,
      after: { queue: "pipeline.audit", attempt: 1, final: true, reason: "private-diagnostic-error" },
    });
  }
  return { ...c, key };
}
it("保存済みの診断を優先表示し、企業に絞った再開画面へ誘導する", async () => {
  const c = await candidate();
  await candidate(false);
  const q = await queue();
  expect(q.total).toBe(2);
  expect(q.items[0]).toMatchObject({
    id: c.audit.id,
    group: "audit_recovery",
    priority: 0,
    action: "保存済み結果で再開",
    href: `/ops/processing?company=${c.company.id}#audit-recovery`,
  });
  expect(q.groups.find((g) => g.key === "audit_recovery")).toMatchObject({
    count: 1,
    href: "/ops/processing#audit-recovery",
  });
  expect(JSON.stringify(q)).not.toContain("private-diagnostic-error");
  expect(JSON.stringify(q)).not.toContain(c.key);
});
it("営業抑止中は診断を再開する代わりに企業情報の確認へ誘導する", async () => {
  const c = await candidate();
  await db.update(companies).set({ suppression: "excluded" }).where(eq(companies.id, c.company.id));
  const q = await queue();
  expect(q.items[0]).toMatchObject({ action: "企業情報を確認", href: `/ops/companies/${c.company.id}` });
  expect(q.items[0]!.reason).toContain("営業抑止中");
});
it.each(["hold", "create"] as const)("%sの再開後は対応待ちと不要な制作準備が消える", async (decision) => {
  const c = await candidate();
  await db.update(siteAudits).set({ decision }).where(eq(siteAudits.id, c.audit.id));
  const { actor } = await seedUser(db, "ops");
  expect((await queue()).total).toBe(1);
  expect(await resumeAuditByOps(db, clock, actor, c.audit.id)).toMatchObject({ ok: true });
  expect((await queue()).total).toBe(0);
  expect(await resumeAuditByOps(db, clock, actor, c.audit.id)).toMatchObject({
    ok: true,
    value: { alreadyApplied: true },
  });
  expect((await queue()).total).toBe(0);
  expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "audit.resumed_by_ops"))).toHaveLength(1);
});
it("21件の総数を保持し、表示は20件で全件確認先を用意する", async () => {
  for (let i = 0; i < 21; i++) await candidate();
  const q = await queue();
  expect(q.total).toBe(21);
  expect(q.items).toHaveLength(20);
  expect(q.groups.find((g) => g.key === "audit_recovery")).toMatchObject({
    count: 21,
    href: "/ops/processing#audit-recovery",
  });
});
it.each([null, new Date("2026-10-17T00:00:00Z")])(
  "制作引き継ぎが存在すれば、送信日時%sにかかわらず手動準備を求めない",
  async (sentAt) => {
    const c = await candidate(false);
    expect((await queue()).items[0]).toMatchObject({ group: "preparation" });
    await db
      .insert(proposalHandoffs)
      .values({ sourceStepKey: c.key, companyId: c.company.id, auditId: c.audit.id, sentAt });
    expect((await queue()).items).toEqual([]);
  },
);
it.each(["hold", "skip", "scoring"] as const)("最新診断が%sなら過去のcreate判定から準備を要求しない", async (state) => {
  const c = await candidate(false);
  await db.insert(siteAudits).values({
    companyId: c.company.id,
    websiteId: c.website.id,
    targetUrl: c.website.url,
    status: state === "scoring" ? "scoring" : "evaluated",
    decision: state === "scoring" ? null : state,
    createdAt: new Date(c.audit.createdAt.getTime() + 1000),
  });
  expect((await queue()).items).toEqual([]);
});
