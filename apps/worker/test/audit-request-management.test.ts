import { randomUUID } from "node:crypto";
import { auditEvents, auditRequests, companies, siteAudits, users, websites } from "@siteoffer/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { auditRequestKey, auditRequestPayload, requestAuditByOps } from "../src/audit-request.ts";
import { dispatchAuditRequests } from "../src/audit-request-dispatch.ts";
import { cancelAuditRequest, listAuditRequests } from "../src/audit-request-management.ts";
import { claimStep, finishStep } from "../src/ledger.ts";
import { QUEUES } from "../src/queues.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

let e: TestEnv;
let ops: { kind: "ops"; userId: string };
beforeEach(async () => {
  e = await setupEnv();
  const [u] = await e.db
    .insert(users)
    .values({ email: "manage@example.test", passwordHash: "fixture", displayName: "運営", role: "ops" })
    .returning();
  ops = { kind: "ops", userId: u!.id };
});
afterEach(async () => {
  await e.cleanup();
});
async function seed(name = "架空・診断の管理") {
  const [c] = await e.db
    .insert(companies)
    .values({ name, officialSiteStatus: "confirmed", pipelineStatus: "failed" })
    .returning();
  const [w] = await e.db
    .insert(websites)
    .values({
      companyId: c!.id,
      url: `https://${c!.id}.example/`,
      normalizedUrl: `${c!.id}.example`,
      domain: `${c!.id}.example`,
      kind: "current",
      isPrimary: true,
    })
    .returning();
  const input = { companyId: c!.id, requestId: randomUUID() };
  expect(await requestAuditByOps(e.db, e.clock, ops, input)).toMatchObject({ ok: true });
  return { c: c!, w: w!, id: input.requestId, payload: auditRequestPayload({ id: input.requestId, companyId: c!.id }) };
}
const actor = { kind: "system", job: "fixture" } as const;
it("同時取消は一度だけ確定し、既存キューの遅い到着でも採点しない", async () => {
  const s = await seed();
  await dispatchAuditRequests(e.deps);
  const results = await Promise.all([
    cancelAuditRequest(e.db, e.clock, ops, s.id),
    cancelAuditRequest(e.db, e.clock, ops, s.id),
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results.filter((r) => r.ok && !r.value.alreadyCancelled)).toHaveLength(1);
  await e.queue.drain(e.runtime);
  expect((await e.db.select().from(auditRequests))[0]!.status).toBe("cancelled");
  expect(await e.db.select().from(siteAudits)).toHaveLength(0);
  expect(e.generator.calls).toHaveLength(0);
  expect(await e.db.select().from(auditEvents).where(eq(auditEvents.action, "audit.request_cancelled"))).toHaveLength(
    1,
  );
  expect(await requestAuditByOps(e.db, e.clock, ops, { companyId: s.c.id, requestId: randomUUID() })).toMatchObject({
    ok: true,
    value: { alreadyAccepted: false },
  });
});
it("送信応答を待っている間の取消も、遅い応答で開始待ちへ戻らない", async () => {
  const s = await seed();
  let entered!: () => void;
  let release!: () => void;
  const entry = new Promise<void>((r) => {
    entered = r;
  });
  const response = new Promise<void>((r) => {
    release = r;
  });
  const dispatch = dispatchAuditRequests({
    ...e.deps,
    queue: {
      send: async (...args: Parameters<typeof e.queue.send>) => {
        await e.queue.send(...args);
        entered();
        await response;
      },
    },
  });
  await entry;
  expect(await cancelAuditRequest(e.db, e.clock, ops, s.id)).toMatchObject({ ok: true });
  release();
  expect(await dispatch).toEqual({ sent: 0, deferred: 1 });
  await e.queue.drain(e.runtime);
  expect((await e.db.select().from(auditRequests))[0]).toMatchObject({
    status: "cancelled",
    leaseToken: null,
    sentAt: null,
  });
  expect(e.generator.calls).toHaveLength(0);
});
it.each(["running", "retry", "completed"])("台帳が%sなら古い開始待ち表示から取り消せない", async (state) => {
  const s = await seed();
  const key = auditRequestKey({ id: s.id, companyId: s.c.id });
  await claimStep(e.db, e.clock, { key, queue: QUEUES.audit, maxAttempts: 3, staleAfterMs: 60000, actor });
  if (state !== "running")
    await finishStep(e.db, e.clock, {
      key,
      queue: QUEUES.audit,
      attempt: 1,
      actor,
      outcome: state === "completed" ? { ok: true } : { ok: false, reason: "fixture", final: false },
    });
  expect(await cancelAuditRequest(e.db, e.clock, ops, s.id)).toMatchObject({ ok: false, error: "already_started" });
  const listed = await listAuditRequests(e.db, ops);
  expect(listed.ok && listed.value.items[0]).toMatchObject({ canCancel: false, status: "processing" });
  expect((await e.db.select().from(auditRequests))[0]!.finishedAt).toBeNull();
});
it("取消履歴を保存できなければ受付の状態も戻す", async () => {
  const s = await seed();
  await e.db.execute(
    sql`create function reject_cancel() returns trigger language plpgsql as $$ begin if NEW.action='audit.request_cancelled' then raise exception 'fixture'; end if; return NEW; end $$`,
  );
  await e.db.execute(
    sql`create trigger reject_cancel before insert on audit_events for each row execute function reject_cancel()`,
  );
  await expect(cancelAuditRequest(e.db, e.clock, ops, s.id)).rejects.toThrow();
  expect((await e.db.select().from(auditRequests))[0]).toMatchObject({ status: "queued", finishedAt: null });
});
it.each(["sales", "suspended", "missing", "anonymous"])("%sは一覧も取消も拒否する", async (kind) => {
  const s = await seed();
  if (kind === "suspended") await e.db.update(users).set({ status: "suspended" });
  const caller =
    kind === "anonymous"
      ? null
      : kind === "sales"
        ? { kind: "sales" as const, userId: ops.userId }
        : kind === "missing"
          ? { kind: "ops" as const, userId: randomUUID() }
          : ops;
  expect(await cancelAuditRequest(e.db, e.clock, caller, s.id)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await listAuditRequests(e.db, caller)).toMatchObject({ ok: false, error: "forbidden" });
});
it("25件を20件ずつ表示し、企業・全文検索・ページ送りが同じ対象を使う", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) ids.push((await seed(i === 24 ? "架空100%診断_最終" : "架空・検索企業")).c.id);
  const first = await listAuditRequests(e.db, ops);
  expect(first).toMatchObject({
    ok: true,
    value: { total: 25, pages: 2, page: 1, counts: { active: 25, attention: 0 } },
  });
  expect(first.ok && first.value.items).toHaveLength(20);
  const second = await listAuditRequests(e.db, ops, { page: 2 });
  expect(second.ok && second.value.items).toHaveLength(5);
  expect(await listAuditRequests(e.db, ops, { query: "100%診断_" })).toMatchObject({ ok: true, value: { total: 1 } });
  expect(await listAuditRequests(e.db, ops, { companyId: ids[24], query: "100%" })).toMatchObject({
    ok: true,
    value: { total: 1 },
  });
  expect(await listAuditRequests(e.db, ops, { page: 999 })).toMatchObject({ ok: true, value: { page: 2 } });
  expect(await listAuditRequests(e.db, ops, { query: "存在しない企業" })).toMatchObject({
    ok: true,
    value: { total: 0, page: 1, pages: 1 },
  });
});
it("再依頼で置き換わった失敗は要確認から外し、全履歴には残す", async () => {
  const s = await seed();
  await e.db.update(auditRequests).set({ status: "failed", finishedAt: e.clock.now() });
  expect(await listAuditRequests(e.db, ops, { view: "attention" })).toMatchObject({ ok: true, value: { total: 1 } });
  await e.db.insert(auditRequests).values({
    id: randomUUID(),
    companyId: s.c.id,
    websiteId: s.w.id,
    targetUrl: s.w.url,
    status: "completed",
    finishedAt: e.clock.now(),
    createdAt: new Date(e.clock.now().getTime() + 1000),
  });
  expect(await listAuditRequests(e.db, ops, { view: "attention" })).toMatchObject({ ok: true, value: { total: 0 } });
  expect(await listAuditRequests(e.db, ops, { view: "open" })).toMatchObject({ ok: true, value: { total: 0 } });
  expect(await listAuditRequests(e.db, ops, { view: "history" })).toMatchObject({ ok: true, value: { total: 2 } });
  expect(await listAuditRequests(e.db, ops, { view: "all" })).toMatchObject({ ok: true, value: { total: 2 } });
});
it("取消済みを対応中に数えず、内部の送信権限やキーは一覧に渡さない", async () => {
  const s = await seed();
  await cancelAuditRequest(e.db, e.clock, ops, s.id);
  expect(await listAuditRequests(e.db, ops)).toMatchObject({
    ok: true,
    value: { total: 0, counts: { all: 1, history: 1 } },
  });
  const r = await listAuditRequests(e.db, ops, { view: "history" });
  expect(r.ok && r.value.items[0]).toMatchObject({ status: "cancelled", canCancel: false });
  expect(JSON.stringify(r)).not.toContain("leaseToken");
  expect(JSON.stringify(r)).not.toContain("ops:");
});
it("不正な表示条件と依頼IDを拒否する", async () => {
  for (const input of [{ view: "wrong" }, { companyId: "bad" }, { query: "x".repeat(201) }])
    expect(await listAuditRequests(e.db, ops, input)).toMatchObject({ ok: false, error: "invalid_input" });
  expect(await cancelAuditRequest(e.db, e.clock, ops, "bad")).toMatchObject({ ok: false, error: "invalid_input" });
  expect(await cancelAuditRequest(e.db, e.clock, ops, randomUUID())).toMatchObject({ ok: false, error: "not_found" });
});
