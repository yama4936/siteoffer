import { randomUUID } from "node:crypto";
import { fixedClock, recordEvent } from "@siteoffer/core";
import { auditRequests, companies, siteAudits, users, websites } from "@siteoffer/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resumeAuditByOps } from "../src/audit-recovery.ts";
import { auditRequestPayload, getCompanyAuditRequest, requestAuditByOps } from "../src/audit-request.ts";
import { dispatchAuditRequests, reconcileAuditRequest } from "../src/audit-request-dispatch.ts";
import { claimStep, finishStep } from "../src/ledger.ts";
import { QUEUES, stepKeys } from "../src/queues.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

let e: TestEnv;
let ops: { kind: "ops"; userId: string };
beforeEach(async () => {
  e = await setupEnv();
  const [u] = await e.db
    .insert(users)
    .values({ email: "request@example.test", passwordHash: "fixture", displayName: "担当", role: "ops" })
    .returning();
  ops = { kind: "ops", userId: u!.id };
});
afterEach(async () => {
  vi.useRealTimers();
  await e.cleanup();
});
async function seed() {
  const [c] = await e.db
    .insert(companies)
    .values({ name: "架空・診断依頼", officialSiteStatus: "confirmed", pipelineStatus: "failed" })
    .returning();
  const [w] = await e.db
    .insert(websites)
    .values({
      companyId: c!.id,
      url: "https://kakuu-koumuten.example.test/",
      normalizedUrl: `${c!.id}.example.test`,
      domain: "kakuu-koumuten.example.test",
      kind: "current",
      isPrimary: true,
    })
    .returning();
  return { c: c!, w: w!, input: { companyId: c!.id, requestId: randomUUID() } };
}
it("同時操作を一件にまとめ、別操作の受付応答消失も完了後に同じ結果へ戻す", async () => {
  const s = await seed();
  const second = { ...s.input, requestId: randomUUID() };
  const r = await Promise.all([
    requestAuditByOps(e.db, e.clock, ops, s.input),
    requestAuditByOps(e.db, e.clock, ops, second),
  ]);
  expect(r.every((x) => x.ok)).toBe(true);
  expect(await e.db.select().from(auditRequests)).toHaveLength(1);
  await e.db.update(auditRequests).set({ status: "failed", finishedAt: e.clock.now() });
  expect(await requestAuditByOps(e.db, e.clock, ops, second)).toMatchObject({
    ok: true,
    value: { requestId: s.input.requestId, alreadyAccepted: true },
  });
  expect(await e.db.select().from(auditRequests)).toHaveLength(1);
  const other = await seed();
  expect(await requestAuditByOps(e.db, e.clock, ops, { ...other.input, requestId: second.requestId })).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
});
it("操作記録の保存失敗時には受付も残さない", async () => {
  const s = await seed();
  await e.db.execute(
    sql`create function reject_request() returns trigger language plpgsql as $$ begin if NEW.action='audit.request_received' then raise exception 'fixture'; end if; return NEW; end $$`,
  );
  await e.db.execute(
    sql`create trigger reject_request before insert on audit_events for each row execute function reject_request()`,
  );
  await expect(requestAuditByOps(e.db, e.clock, ops, s.input)).rejects.toThrow();
  expect(await e.db.select().from(auditRequests)).toHaveLength(0);
});
it.each(["sales", "disabled", "missing", "anonymous"])("%sからの受付・状態参照を拒否する", async (kind) => {
  const s = await seed();
  if (kind === "disabled") await e.db.update(users).set({ status: "suspended" });
  const actor =
    kind === "anonymous"
      ? null
      : kind === "sales"
        ? { kind: "sales" as const, userId: ops.userId }
        : kind === "missing"
          ? { kind: "ops" as const, userId: randomUUID() }
          : ops;
  expect(await requestAuditByOps(e.db, e.clock, actor, s.input)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await getCompanyAuditRequest(e.db, actor, s.c.id)).toMatchObject({ ok: false, error: "forbidden" });
});
it.each(["suppression", "unconfirmed", "private", "active", "sales"])(
  "%sの企業は新規診断を受け付けない",
  async (state) => {
    const s = await seed();
    if (state === "suppression") await e.db.update(companies).set({ suppression: "excluded" });
    if (state === "unconfirmed") await e.db.update(companies).set({ officialSiteStatus: "needs_review" });
    if (state === "private") await e.db.update(websites).set({ url: "http://127.0.0.1/" });
    if (state === "sales") await e.db.update(companies).set({ pipelineStatus: "sellable" });
    if (state === "active")
      await e.db
        .insert(siteAudits)
        .values({ companyId: s.c.id, websiteId: s.w.id, targetUrl: s.w.url, status: "scoring" });
    expect(await requestAuditByOps(e.db, e.clock, ops, s.input)).toMatchObject({ ok: false, error: "not_ready" });
    expect(await e.db.select().from(auditRequests)).toHaveLength(0);
  },
);
it("送信失敗を保存し、再送と診断実行・結果反映まで一度で完了する", async () => {
  const s = await seed();
  expect(await requestAuditByOps(e.db, e.clock, ops, s.input)).toMatchObject({ ok: true });
  const bad = {
    ...e.deps,
    queue: {
      send: async () => {
        throw Error("private-connection-secret");
      },
    },
  };
  expect(await dispatchAuditRequests(bad)).toEqual({ sent: 0, deferred: 1 });
  expect(JSON.stringify(await getCompanyAuditRequest(e.db, ops, s.c.id))).not.toContain("private-connection-secret");
  const later = fixedClock(new Date(e.clock.now().getTime() + 31000));
  expect(await dispatchAuditRequests({ ...e.deps, clock: later })).toEqual({ sent: 1, deferred: 0 });
  await e.queue.drain(e.runtime);
  expect((await e.db.select().from(auditRequests))[0]).toMatchObject({ status: "completed" });
  expect(await e.db.select().from(siteAudits)).toHaveLength(1);
  expect(e.generator.calls).toHaveLength(1);
  await e.runtime.run(QUEUES.audit, auditRequestPayload({ id: s.input.requestId, companyId: s.c.id }));
  expect(await e.db.select().from(siteAudits)).toHaveLength(1);
});
it("送信応答が消失しても同じキーを再送し一回だけ実行する", async () => {
  const s = await seed();
  await requestAuditByOps(e.db, e.clock, ops, s.input);
  const lost = {
    ...e.deps,
    queue: {
      send: async (...args: Parameters<typeof e.queue.send>) => {
        await e.queue.send(...args);
        throw Error("response lost");
      },
    },
  };
  await dispatchAuditRequests(lost);
  await dispatchAuditRequests({ ...e.deps, clock: fixedClock(new Date(e.clock.now().getTime() + 31000)) });
  expect(e.queue.size).toBe(1);
  await e.queue.drain(e.runtime);
  expect(e.generator.calls).toHaveLength(1);
});
it.each(["before_send", "after_send"])("%sのサイト変更を実行前に検知する", async (when) => {
  const s = await seed();
  await requestAuditByOps(e.db, e.clock, ops, s.input);
  if (when === "after_send") await dispatchAuditRequests(e.deps);
  await e.db.update(websites).set({ url: "https://changed.example.test/" });
  if (when === "before_send") await dispatchAuditRequests(e.deps);
  else await e.queue.drain(e.runtime);
  const [r] = await e.db.select().from(auditRequests);
  expect(r!.finishedAt).not.toBeNull();
  expect(r!.message).toContain("公式サイトが変更");
  expect(e.generator.calls).toHaveLength(0);
  expect(await e.db.select().from(siteAudits)).toHaveLength(0);
});
it("親処理の最終失敗を後から照合し、新しい依頼を受け付け直せる", async () => {
  const s = await seed();
  await requestAuditByOps(e.db, e.clock, ops, s.input);
  const key = stepKeys.audit(auditRequestPayload({ id: s.input.requestId, companyId: s.c.id }));
  const actor = { kind: "system", job: "fixture" } as const;
  await claimStep(e.db, e.clock, { key, queue: QUEUES.audit, maxAttempts: 1, staleAfterMs: 60000, actor });
  await finishStep(e.db, e.clock, {
    key,
    queue: QUEUES.audit,
    attempt: 1,
    actor,
    outcome: { ok: false, reason: "private-failure", final: true },
  });
  await reconcileAuditRequest(e.db, e.clock, s.input.requestId);
  expect((await e.db.select().from(auditRequests))[0]).toMatchObject({ status: "failed" });
  expect(await requestAuditByOps(e.db, e.clock, ops, { ...s.input, requestId: randomUUID() })).toMatchObject({
    ok: true,
    value: { alreadyAccepted: false },
  });
});
it("保存済み結果を再開できる場合は採点のやり直しを案内しない", async () => {
  const s = await seed();
  const key = `audit:${s.c.id}:recovery`;
  const actor = { kind: "system", job: "fixture" } as const;
  const [a] = await e.db
    .insert(siteAudits)
    .values({ companyId: s.c.id, websiteId: s.w.id, targetUrl: s.w.url, status: "evaluated", decision: "hold" })
    .returning();
  await recordEvent(e.db, e.clock, {
    actor,
    action: "site_audit.started",
    targetType: "site_audit",
    targetId: a!.id,
    after: { workerStepKey: key },
  });
  await recordEvent(e.db, e.clock, {
    actor,
    action: "worker.step_started",
    targetType: "worker_step",
    targetId: key,
    after: { queue: QUEUES.audit, attempt: 1, payload: { companyId: s.c.id, requestKey: "recovery" } },
  });
  await recordEvent(e.db, e.clock, {
    actor,
    action: "worker.step_failed",
    targetType: "worker_step",
    targetId: key,
    after: { queue: QUEUES.audit, attempt: 1, final: true },
  });
  expect(await requestAuditByOps(e.db, e.clock, ops, s.input)).toMatchObject({
    ok: false,
    message: expect.stringContaining("保存済みの診断"),
  });
});

it("送信中の期限切れを別ワーカーが引き継いでも、古い応答は受付を上書きしない", async () => {
  const s = await seed();
  await requestAuditByOps(e.db, e.clock, ops, s.input);
  let now = e.clock.now();
  const clock = { now: () => now };
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((r) => {
    entered = r;
  });
  const response = new Promise<void>((r) => {
    release = r;
  });
  const first = dispatchAuditRequests({
    ...e.deps,
    clock,
    queue: {
      send: async (...args: Parameters<typeof e.queue.send>) => {
        await e.queue.send(...args);
        entered();
        await response;
      },
    },
  });
  await enteredPromise;
  now = new Date(now.getTime() + 61000);
  expect(await dispatchAuditRequests({ ...e.deps, clock })).toEqual({ sent: 1, deferred: 0 });
  release();
  expect(await first).toEqual({ sent: 0, deferred: 1 });
  const [r] = await e.db.select().from(auditRequests);
  expect(r).toMatchObject({ attempts: 2, sentAt: now, leaseToken: null });
  expect(e.queue.size).toBe(1);
});
it("別の診断が先に開始したら、企業状態を失敗へ戻さず追加の採点を止める", async () => {
  const s = await seed();
  await requestAuditByOps(e.db, e.clock, ops, s.input);
  await dispatchAuditRequests(e.deps);
  await e.db.insert(siteAudits).values({ companyId: s.c.id, websiteId: s.w.id, targetUrl: s.w.url, status: "scoring" });
  await e.db.update(companies).set({ pipelineStatus: "site_confirmed" }).where(eq(companies.id, s.c.id));
  await e.queue.drain(e.runtime);
  expect((await e.db.select().from(companies))[0]!.pipelineStatus).toBe("site_confirmed");
  expect((await e.db.select().from(siteAudits)).map((a) => a.status)).toEqual(["scoring"]);
  expect(e.generator.calls).toHaveLength(0);
});
it("対象変更で終了した受付が遅れて届いても再実行しない", async () => {
  const s = await seed();
  await requestAuditByOps(e.db, e.clock, ops, s.input);
  await e.db.update(websites).set({ url: "https://other.example.test/" });
  await dispatchAuditRequests(e.deps);
  await e.db.update(websites).set({ url: s.w.url });
  await e.runtime.run(QUEUES.audit, auditRequestPayload({ id: s.input.requestId, companyId: s.c.id }));
  expect((await e.db.select().from(auditRequests))[0]!.status).toBe("blocked");
  expect(e.generator.calls).toHaveLength(0);
  expect(await e.db.select().from(siteAudits)).toHaveLength(0);
});
it("収集専用のワーカーでは診断依頼を処理しない", async () => {
  const s = await seed();
  await requestAuditByOps(e.db, e.clock, ops, s.input);
  expect(await dispatchAuditRequests({ ...e.deps, discoveryOnly: true })).toEqual({ sent: 0, deferred: 0 });
  expect(e.queue.size).toBe(0);
});

it("保存済み診断の手動再開が成功したら、停止した受付表示も完了へそろう", async () => {
  const s = await seed();
  await requestAuditByOps(e.db, e.clock, ops, s.input);
  const payload = auditRequestPayload({ id: s.input.requestId, companyId: s.c.id });
  const key = stepKeys.audit(payload);
  const actor = { kind: "system", job: "fixture" } as const;
  const [a] = await e.db
    .insert(siteAudits)
    .values({ companyId: s.c.id, websiteId: s.w.id, targetUrl: s.w.url, status: "evaluated", decision: "hold" })
    .returning();
  await recordEvent(e.db, e.clock, {
    actor,
    action: "site_audit.started",
    targetType: "site_audit",
    targetId: a!.id,
    after: { workerStepKey: key },
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
    after: { queue: QUEUES.audit, attempt: 1, final: true },
  });
  await reconcileAuditRequest(e.db, e.clock, s.input.requestId);
  expect((await e.db.select().from(auditRequests))[0]!.status).toBe("failed");
  expect(await resumeAuditByOps(e.db, e.clock, ops, a!.id)).toMatchObject({ ok: true });
  expect(await getCompanyAuditRequest(e.db, ops, s.c.id)).toMatchObject({
    ok: true,
    value: { request: { status: "completed", message: expect.stringContaining("保存済み") } },
  });
  expect(e.generator.calls).toHaveLength(0);
});

it("中断後の再試行でサイト変更を検知しても、前の取得中履歴を残さない", async () => {
  const s = await seed();
  await requestAuditByOps(e.db, e.clock, ops, s.input);
  const payload = auditRequestPayload({ id: s.input.requestId, companyId: s.c.id });
  const key = stepKeys.audit(payload);
  const actor = { kind: "system", job: "fixture" } as const;
  const [a] = await e.db
    .insert(siteAudits)
    .values({ companyId: s.c.id, websiteId: s.w.id, targetUrl: s.w.url, status: "collecting" })
    .returning();
  await recordEvent(e.db, e.clock, {
    actor,
    action: "site_audit.started",
    targetType: "site_audit",
    targetId: a!.id,
    after: { workerStepKey: key },
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
    after: { queue: QUEUES.audit, attempt: 1, final: false },
  });
  await e.db.update(websites).set({ url: "https://changed.example.test/" });
  await e.runtime.run(QUEUES.audit, payload);
  expect((await e.db.select().from(siteAudits))[0]!.status).toBe("failed");
  expect(e.generator.calls).toHaveLength(0);
});
