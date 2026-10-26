import { randomUUID } from "node:crypto";
import { fixedClock, recordEvent } from "@siteoffer/core";
import { auditEvents, auditRequests, companies, type Db, proposalHandoffs, siteAudits, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { resumeAuditByOps } from "@siteoffer/worker/audit-recovery";
import { listAuditRequests } from "@siteoffer/worker/audit-request-management";
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
async function candidate(recoverable = true, requestId?: string) {
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
  const payload = { companyId: c.company.id, requestKey: requestId ? `ops:${requestId}` : "dashboard-recovery" };
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
    group: "audit_attention",
    priority: 0,
    action: "保存済み結果で再開",
    href: `/ops/processing?company=${c.company.id}#audit-recovery`,
  });
  expect(q.groups.find((g) => g.key === "audit_attention")).toMatchObject({
    count: 1,
    href: "/ops/processing#audit-attention",
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
  for (let i = 0; i < 21; i++) {
    const c = await candidate();
    await db.insert(auditRequests).values({
      id: randomUUID(),
      companyId: c.company.id,
      websiteId: c.website.id,
      targetUrl: c.website.url,
      status: "failed",
      finishedAt: clock.now(),
    });
  }
  const q = await queue();
  expect(q.total).toBe(21);
  expect(q.items).toHaveLength(20);
  expect(q.groups.find((g) => g.key === "audit_attention")).toMatchObject({
    count: 21,
    href: "/ops/processing#audit-attention",
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

it("再診断の受付中には古い診断から手動制作の準備を求めない", async () => {
  const c = await candidate(false);
  await db
    .insert(auditRequests)
    .values({ id: crypto.randomUUID(), companyId: c.company.id, websiteId: c.website.id, targetUrl: c.website.url });
  expect((await queue()).items).toEqual([]);
});

async function stopped(status: "failed" | "blocked" = "failed") {
  const [company] = await db
    .insert(companies)
    .values({
      name: `架空・診断停止${status}`,
      pipelineStatus: "failed",
      officialSiteStatus: "confirmed",
    })
    .returning();
  const [website] = await db
    .insert(websites)
    .values({
      companyId: company!.id,
      url: `https://${company!.id}.example/`,
      normalizedUrl: `${company!.id}.example`,
      domain: `${company!.id}.example`,
      kind: "current",
      isPrimary: true,
    })
    .returning();
  const [request] = await db
    .insert(auditRequests)
    .values({
      id: randomUUID(),
      companyId: company!.id,
      websiteId: website!.id,
      targetUrl: website!.url,
      status,
      finishedAt: clock.now(),
      createdAt: clock.now(),
      message: "private-dispatch-error",
      leaseToken: randomUUID(),
    })
    .returning();
  return { company: company!, website: website!, request: request! };
}
it.each(["failed", "blocked"] as const)(
  "保存結果のない%s依頼もホームで案内し、空の再開欄へ誘導しない",
  async (status) => {
    const c = await stopped(status);
    const q = await queue();
    expect(q.total).toBe(1);
    expect(q.items[0]).toMatchObject({
      id: c.request.id,
      group: "audit_attention",
      priority: 0,
      action: "診断・企業情報を確認",
      href: `/ops/companies/${c.company.id}#audit-request`,
    });
    expect(q.items[0]!.reason).toContain(status === "blocked" ? "診断対象の確認" : "診断が停止");
    expect(JSON.stringify(q)).not.toContain("private-dispatch-error");
    expect(JSON.stringify(q)).not.toContain(c.request.leaseToken);
    const { actor } = await seedUser(db, "ops");
    const list = await listAuditRequests(db, actor, { view: "attention" });
    expect(list.ok && list.value.items[0]).toMatchObject({ hasSavedResult: false });
  },
);
it.each(["queued", "completed", "cancelled"] as const)(
  "後続の%s依頼があれば以前の失敗をホームから外す",
  async (status) => {
    const c = await stopped();
    await db.insert(auditRequests).values({
      id: randomUUID(),
      companyId: c.company.id,
      websiteId: c.website.id,
      targetUrl: c.website.url,
      status,
      createdAt: new Date(clock.now().getTime() + 1000),
      finishedAt: status === "queued" ? null : clock.now(),
    });
    expect((await queue()).items).toEqual([]);
  },
);
it("保存済み結果と停止依頼を1件として案内し、再開すると両方の対応待ちが消える", async () => {
  const requestId = randomUUID();
  const c = await candidate(true, requestId);
  await db.insert(auditRequests).values({
    id: requestId,
    companyId: c.company.id,
    websiteId: c.website.id,
    targetUrl: c.website.url,
    status: "failed",
    finishedAt: clock.now(),
  });
  expect((await queue()).items).toMatchObject([{ id: c.audit.id, action: "保存済み結果で再開" }]);
  expect((await queue()).total).toBe(1);
  const { actor } = await seedUser(db, "ops");
  const list = await listAuditRequests(db, actor, { view: "attention" });
  expect(list.ok && list.value.items[0]).toMatchObject({ id: requestId, hasSavedResult: true });
  const oldCompleted = randomUUID();
  await db.insert(auditRequests).values({
    id: oldCompleted,
    companyId: c.company.id,
    websiteId: c.website.id,
    targetUrl: c.website.url,
    status: "completed",
    finishedAt: clock.now(),
    createdAt: new Date(c.audit.createdAt.getTime() - 1000),
  });
  const all = await listAuditRequests(db, actor, { view: "all" });
  expect(all.ok && all.value.items.find((r) => r.id === oldCompleted)).toMatchObject({ hasSavedResult: false });
  expect(all.ok && all.value.items.find((r) => r.id === requestId)).toMatchObject({ hasSavedResult: true });
  expect(await resumeAuditByOps(db, clock, actor, c.audit.id)).toMatchObject({ ok: true });
  expect((await queue()).items).toEqual([]);
  expect((await queue()).total).toBe(0);
  const history = await listAuditRequests(db, actor, { view: "history" });
  expect(history.ok && history.value.items[0]).toMatchObject({ status: "completed", hasSavedResult: false });
});
it("最新でない診断結果から再開導線を出さない", async () => {
  const c = await candidate();
  await db.insert(auditRequests).values({
    id: randomUUID(),
    companyId: c.company.id,
    websiteId: c.website.id,
    targetUrl: c.website.url,
    status: "failed",
    finishedAt: clock.now(),
  });
  await db.insert(siteAudits).values({
    companyId: c.company.id,
    websiteId: c.website.id,
    targetUrl: c.website.url,
    status: "failed",
    createdAt: new Date(c.audit.createdAt.getTime() + 1000),
  });
  const q = await queue();
  expect(q.total).toBe(1);
  expect(q.items[0]!.action).toBe("診断・企業情報を確認");
  const { actor } = await seedUser(db, "ops");
  const list = await listAuditRequests(db, actor, { view: "attention" });
  expect(list.ok && list.value.items[0]!.hasSavedResult).toBe(false);
});
