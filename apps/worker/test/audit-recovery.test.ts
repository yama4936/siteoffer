import { recordEvent } from "@siteoffer/core";
import { auditEvents, companies, proposalHandoffs, siteAudits, users, websites } from "@siteoffer/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAuditRecoveryCandidates, resumeAuditByOps } from "../src/audit-recovery.ts";
import { QUEUES, stepKeys } from "../src/queues.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

let e: TestEnv;
let ops: { kind: "ops"; userId: string };
beforeEach(async () => {
  e = await setupEnv();
  const [u] = await e.db
    .insert(users)
    .values({ email: "resume-ops@example.test", passwordHash: "not-a-login", displayName: "再開担当", role: "ops" })
    .returning();
  ops = { kind: "ops", userId: u!.id };
});
afterEach(async () => {
  await e.cleanup();
});
async function seed(decision: "create" | "hold" | "skip" = "create") {
  const [c] = await e.db
    .insert(companies)
    .values({ name: "保存済み診断の試験", officialSiteStatus: "confirmed", pipelineStatus: "failed" })
    .returning();
  const [w] = await e.db
    .insert(websites)
    .values({
      companyId: c!.id,
      url: `https://${c!.id}.example/`,
      normalizedUrl: `https://${c!.id}.example/`,
      domain: `${c!.id}.example`,
      kind: "current",
      isPrimary: true,
    })
    .returning();
  const [a] = await e.db
    .insert(siteAudits)
    .values({
      companyId: c!.id,
      websiteId: w!.id,
      targetUrl: w!.url,
      status: "evaluated",
      decision,
      createdAt: e.clock.now(),
    })
    .returning();
  const payload = { companyId: c!.id, requestKey: "resume-ui" };
  const key = stepKeys.audit(payload);
  const actor = { kind: "system", job: "fixture" } as const;
  await recordEvent(e.db, e.clock, {
    actor,
    action: "site_audit.started",
    targetType: "site_audit",
    targetId: a!.id,
    after: { workerStepKey: key, workerAttempt: 1 },
  });
  await recordEvent(e.db, e.clock, {
    actor,
    action: "worker.step_started",
    targetType: "worker_step",
    targetId: key,
    after: { queue: QUEUES.audit, attempt: 1, payload },
  });
  await recordEvent(e.db, e.clock, {
    actor,
    action: "worker.step_failed",
    targetType: "worker_step",
    targetId: key,
    after: { queue: QUEUES.audit, attempt: 1, final: true, reason: "private-runtime-error" },
  });
  return { c: c!, w: w!, a: a!, key, payload };
}
describe("運営による保存済み診断の再開", () => {
  it.each(["create", "hold", "skip"] as const)("%sの判定を一度だけ適用し、元の失敗履歴を保持する", async (decision) => {
    const s = await seed(decision);
    const before = await getAuditRecoveryCandidates(e.db, ops);
    expect(before).toMatchObject({ ok: true, value: { total: 1 } });
    expect(JSON.stringify(before)).not.toContain("private-runtime-error");
    expect(JSON.stringify(before)).not.toContain(s.key);
    const results = await Promise.all([
      resumeAuditByOps(e.db, e.clock, ops, s.a.id),
      resumeAuditByOps(e.db, e.clock, ops, s.a.id),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.value.alreadyApplied)).toHaveLength(1);
    expect(await e.db.select().from(proposalHandoffs)).toHaveLength(decision === "create" ? 1 : 0);
    expect(await e.db.select().from(auditEvents).where(eq(auditEvents.action, "audit.resumed_by_ops"))).toHaveLength(1);
    expect(await e.db.select().from(auditEvents).where(eq(auditEvents.action, "worker.step_failed"))).toHaveLength(1);
    expect((await e.db.select().from(companies))[0]!.pipelineStatus).toBe(decision === "hold" ? "on_hold" : "audited");
    expect(await getAuditRecoveryCandidates(e.db, ops)).toMatchObject({ ok: true, value: { total: 0 } });
    expect(e.generator.calls).toHaveLength(0);
    expect(e.queue.size).toBe(0);
  });
  it("運営記録が保存できなければ企業状態・制作受付も戻す", async () => {
    const s = await seed();
    await e.db.execute(
      sql`create function reject_manual_resume() returns trigger language plpgsql as $$ begin if NEW.action='audit.resumed_by_ops' then raise exception 'test'; end if; return NEW; end $$`,
    );
    await e.db.execute(
      sql`create trigger reject_manual_resume before insert on audit_events for each row execute function reject_manual_resume()`,
    );
    await expect(resumeAuditByOps(e.db, e.clock, ops, s.a.id)).rejects.toThrow();
    expect(await e.db.select().from(proposalHandoffs)).toHaveLength(0);
    expect((await e.db.select().from(companies))[0]!.pipelineStatus).toBe("failed");
    expect(await getAuditRecoveryCandidates(e.db, ops)).toMatchObject({ ok: true, value: { total: 1 } });
  });
  it.each(["sales", "disabled", "missing", "anonymous"])("%sは一覧も再開も利用できない", async (kind) => {
    const s = await seed();
    let actor: typeof ops | { kind: "sales"; userId: string } | null = ops;
    if (kind === "sales") actor = { kind: "sales", userId: ops.userId };
    if (kind === "disabled") await e.db.update(users).set({ status: "suspended" });
    if (kind === "missing") actor = { kind: "ops", userId: crypto.randomUUID() };
    if (kind === "anonymous") actor = null;
    expect(await getAuditRecoveryCandidates(e.db, actor)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await resumeAuditByOps(e.db, e.clock, actor, s.a.id)).toMatchObject({ ok: false, error: "forbidden" });
  });
  it.each(["active", "retryable", "newer-audit", "suppressed", "site-changed", "missing-payload"])(
    "%sへの変更を再確認して再開を拒否する",
    async (kind) => {
      const s = await seed();
      expect(await getAuditRecoveryCandidates(e.db, ops)).toMatchObject({ ok: true, value: { total: 1 } });
      if (kind === "active")
        await recordEvent(e.db, e.clock, {
          actor: ops,
          action: "worker.step_started",
          targetType: "worker_step",
          targetId: s.key,
          after: { queue: QUEUES.audit, attempt: 2, payload: s.payload },
        });
      if (kind === "retryable")
        await e.db
          .update(auditEvents)
          .set({ after: { attempt: 1, final: false } })
          .where(eq(auditEvents.action, "worker.step_failed"));
      if (kind === "newer-audit") {
        e.clock.advance(1);
        await e.db.insert(siteAudits).values({
          companyId: s.c.id,
          websiteId: s.w.id,
          targetUrl: s.w.url,
          status: "scoring",
          createdAt: e.clock.now(),
        });
      }
      if (kind === "suppressed") await e.db.update(companies).set({ suppression: "excluded" });
      if (kind === "site-changed") await e.db.update(websites).set({ url: "https://changed.example/" });
      if (kind === "missing-payload")
        await e.db
          .update(auditEvents)
          .set({ after: { queue: QUEUES.audit, attempt: 1 } })
          .where(eq(auditEvents.action, "worker.step_started"));
      expect(await resumeAuditByOps(e.db, e.clock, ops, s.a.id)).toMatchObject({ ok: false, error: "not_resumable" });
      expect(await e.db.select().from(proposalHandoffs)).toHaveLength(0);
      const shown = await getAuditRecoveryCandidates(e.db, ops);
      if (shown.ok && shown.value.items.length) expect(shown.value.items[0]!.blockedReason).toBeTruthy();
    },
  );
  it("21件のページ送りと企業絞り込み、範囲外ページ補正を行う", async () => {
    const first = await seed();
    for (let i = 0; i < 20; i++) {
      e.clock.advance(1);
      await seed();
    }
    const page1 = await getAuditRecoveryCandidates(e.db, ops);
    const page2 = await getAuditRecoveryCandidates(e.db, ops, undefined, 2);
    expect(page1).toMatchObject({ ok: true, value: { total: 21, page: 1, pages: 2 } });
    expect(page2).toMatchObject({ ok: true, value: { total: 21, page: 2, pages: 2 } });
    if (page1.ok && page2.ok) {
      expect(page1.value.items).toHaveLength(20);
      expect(page2.value.items).toHaveLength(1);
      expect(new Set([...page1.value.items, ...page2.value.items].map((r) => r.auditId)).size).toBe(21);
    }
    expect(await getAuditRecoveryCandidates(e.db, ops, first.c.id, 999)).toMatchObject({
      ok: true,
      value: { total: 1, page: 1, pages: 1 },
    });
    expect(await resumeAuditByOps(e.db, e.clock, ops, "bad-id")).toMatchObject({ ok: false, error: "invalid_input" });
  });
});
