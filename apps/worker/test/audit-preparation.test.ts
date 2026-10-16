import { randomUUID } from "node:crypto";
import { fixedClock, recordEvent } from "@siteoffer/core";
import { auditEvents, auditRequests, companies, type Db, siteAudits, users, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listAuditPreparation, requestPreparedAudits } from "../src/audit-preparation.ts";

import { auditRequestKey, validateAuditRequest } from "../src/audit-request.ts";

let db: Db;
let close: () => Promise<void>;
let ops: { kind: "ops"; userId: string };
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [u] = await db
    .insert(users)
    .values({ email: "prep@example.test", passwordHash: "fixture", displayName: "運営", role: "ops" })
    .returning();
  ops = { kind: "ops", userId: u!.id };
});
afterEach(async () => {
  await close();
});
async function seed(name = "架空・診断準備") {
  const [c] = await db
    .insert(companies)
    .values({ name, officialSiteStatus: "confirmed", pipelineStatus: "collected" })
    .returning();
  const [w] = await db
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
  return { c: c!, w: w!, input: { companyId: c!.id, websiteId: w!.id, targetUrl: w!.url, requestId: randomUUID() } };
}
it("25社の全件から検索して20社ずつ表示し、未登録・非公開URLは選択不可にする", async () => {
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push(await seed(i === 24 ? "架空100%準備_最終" : "架空・診断準備"));
  const first = await listAuditPreparation(db, ops);
  expect(first).toMatchObject({ ok: true, value: { total: 25, page: 1, pages: 2 } });
  expect(first.ok && first.value.items).toHaveLength(20);
  expect(await listAuditPreparation(db, ops, { query: "100%準備_", page: 999 })).toMatchObject({
    ok: true,
    value: { total: 1, page: 1, pages: 1 },
  });
  const last = await listAuditPreparation(db, ops, { page: 999 });
  expect(last.ok && last.value.items).toHaveLength(5);
  await db.update(websites).set({ url: "http://127.0.0.1/" }).where(eq(websites.id, rows[0]!.w.id));
  const unsafe = await listAuditPreparation(db, ops, { companyId: rows[0]!.c.id });
  expect(unsafe.ok && unsafe.value.items[0]).toMatchObject({ targetUrl: null, blockedReason: expect.any(String) });
  await db.delete(websites).where(eq(websites.id, rows[0]!.w.id));
  const missing = await listAuditPreparation(db, ops, { companyId: rows[0]!.c.id });
  expect(missing.ok && missing.value.items[0]).toMatchObject({
    websiteId: null,
    targetUrl: null,
    blockedReason: expect.any(String),
  });
});
it("確認前・営業抑止・後続作業中・診断履歴あり・受付履歴ありを準備待ちへ戻さない", async () => {
  const ready = await seed();
  for (const status of ["candidate", "needs_review", "not_found"] as const) {
    const c = await seed();
    await db.update(companies).set({ officialSiteStatus: status }).where(eq(companies.id, c.c.id));
  }
  for (const suppression of ["do_not_contact", "excluded", "existing_customer"] as const) {
    const c = await seed();
    await db.update(companies).set({ suppression }).where(eq(companies.id, c.c.id));
  }
  for (const pipelineStatus of ["audited", "on_hold", "failed", "sellable"] as const) {
    const c = await seed();
    await db.update(companies).set({ pipelineStatus }).where(eq(companies.id, c.c.id));
  }
  for (const status of ["queued", "scoring", "evaluated", "failed"] as const) {
    const c = await seed();
    await db.insert(siteAudits).values({ companyId: c.c.id, websiteId: c.w.id, targetUrl: c.w.url, status });
  }
  for (const status of ["queued", "completed", "cancelled", "failed"] as const) {
    const c = await seed();
    await db.insert(auditRequests).values({
      id: randomUUID(),
      companyId: c.c.id,
      websiteId: c.w.id,
      targetUrl: c.w.url,
      status,
      finishedAt: status === "queued" ? null : clock.now(),
    });
  }
  const result = await listAuditPreparation(db, ops);
  expect(result.ok && result.value.items.map((r) => r.companyId)).toEqual([ready.c.id]);
});
it("別経路のキューで開始待ち・再試行・実行中の診断と制作は準備から除く", async () => {
  await db.execute(sql`create schema pgboss`);
  await db.execute(sql`create table pgboss.job(name text,data jsonb,state text)`);
  for (const name of ["pipeline.audit", "pipeline.proposal"])
    for (const state of ["created", "retry", "active"]) {
      const c = await seed();
      await db.execute(
        sql`insert into pgboss.job values(${name},${JSON.stringify({ companyId: c.c.id })}::jsonb,${state})`,
      );
    }
  const stopped = await seed();
  await db.execute(
    sql`insert into pgboss.job values('pipeline.audit',${JSON.stringify({ companyId: stopped.c.id })}::jsonb,'failed')`,
  );
  const result = await listAuditPreparation(db, ops);
  expect(result.ok && result.value.items.map((r) => r.companyId)).toEqual([stopped.c.id]);
});
it("同じ一括操作の同時送信と遅い再送が企業ごとに一つの受付へ集約する", async () => {
  const a = await seed(),
    b = await seed();
  const input = [a.input, b.input];
  const results = await Promise.all([
    requestPreparedAudits(db, clock, ops, input),
    requestPreparedAudits(db, clock, ops, input),
  ]);
  expect(results.every((r) => r.ok && r.value.items.every((i) => i.ok))).toBe(true);
  expect(await db.select().from(auditRequests)).toHaveLength(2);
  expect(await listAuditPreparation(db, ops)).toMatchObject({ ok: true, value: { total: 0 } });
  await db.update(auditRequests).set({ status: "completed", finishedAt: clock.now() });
  expect(await requestPreparedAudits(db, clock, ops, input)).toMatchObject({
    ok: true,
    value: { items: [{ ok: true }, { ok: true }] },
  });
  expect(await db.select().from(auditRequests)).toHaveLength(2);
});
it("選択後に公式サイトが差し替わった企業だけを拒否し、他の企業は受け付ける", async () => {
  const a = await seed(),
    b = await seed();
  await db.update(websites).set({ url: "https://changed.example/" }).where(eq(websites.id, b.w.id));
  const result = await requestPreparedAudits(db, clock, ops, [a.input, b.input]);
  expect(result).toMatchObject({
    ok: true,
    value: {
      items: [
        { companyId: a.c.id, ok: true },
        { companyId: b.c.id, ok: false, message: expect.stringContaining("診断対象が変更") },
      ],
    },
  });
  expect(await db.select().from(auditRequests)).toHaveLength(1);
});
it("選択後に他経路で診断済みになった企業を再診断しない", async () => {
  const c = await seed();
  await db
    .insert(siteAudits)
    .values({ companyId: c.c.id, websiteId: c.w.id, targetUrl: c.w.url, status: "evaluated", decision: "hold" });
  expect(await requestPreparedAudits(db, clock, ops, [c.input])).toMatchObject({
    ok: true,
    value: { items: [{ ok: false, message: expect.stringContaining("すでに診断") }] },
  });
  expect(await db.select().from(auditRequests)).toHaveLength(0);
});
it("途中の監査保存失敗はその企業だけを戻し、同じ操作の再送で残りを受け付ける", async () => {
  const a = await seed(),
    b = await seed();
  await db.execute(
    sql.raw(
      `create function reject_prep() returns trigger language plpgsql as $$ begin if NEW.action='audit.requested' and NEW.target_id='${b.c.id}' then raise exception 'private-test-detail'; end if; return NEW; end $$`,
    ),
  );
  await db.execute(
    sql`create trigger reject_prep before insert on audit_events for each row execute function reject_prep()`,
  );
  const result = await requestPreparedAudits(db, clock, ops, [a.input, b.input]);
  expect(result).toMatchObject({ ok: true, value: { items: [{ ok: true }, { ok: false }] } });
  expect(JSON.stringify(result)).not.toContain("private-test-detail");
  expect(await db.select().from(auditRequests)).toHaveLength(1);
  await db.execute(sql`drop trigger reject_prep on audit_events`);
  expect(await requestPreparedAudits(db, clock, ops, [a.input, b.input])).toMatchObject({
    ok: true,
    value: { items: [{ ok: true }, { ok: true }] },
  });
  expect(await db.select().from(auditRequests)).toHaveLength(2);
  expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "audit.requested"))).toHaveLength(2);
});
it.each(["sales", "suspended", "missing", "anonymous"])("%sの一覧取得と一括受付を拒否する", async (kind) => {
  const c = await seed();
  if (kind === "suspended") await db.update(users).set({ status: "suspended" });
  const actor =
    kind === "anonymous"
      ? null
      : kind === "sales"
        ? { kind: "sales" as const, userId: ops.userId }
        : kind === "missing"
          ? { kind: "ops" as const, userId: randomUUID() }
          : ops;
  expect(await listAuditPreparation(db, actor)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await requestPreparedAudits(db, clock, actor, [c.input])).toMatchObject({ ok: false, error: "forbidden" });
  expect(await db.select().from(auditRequests)).toHaveLength(0);
});
it("20社上限・重複・不正URL・余分な入力を受付前に拒否する", async () => {
  const a = await seed(),
    b = await seed();
  for (const input of [
    [],
    Array.from({ length: 21 }, () => a.input),
    [a.input, a.input],
    [a.input, { ...b.input, requestId: a.input.requestId }],
    [{ ...a.input, targetUrl: "http://localhost/" }],
    [{ ...a.input, unexpected: true }],
    null,
  ])
    expect(await requestPreparedAudits(db, clock, ops, input)).toMatchObject({ ok: false, error: "invalid_input" });
  expect(await db.select().from(auditRequests)).toHaveLength(0);
  for (const input of [{ companyId: "bad" }, { query: "x".repeat(201) }])
    expect(await listAuditPreparation(db, ops, input)).toMatchObject({ ok: false, error: "invalid_input" });
});

it("一括受付の途中で利用停止になった場合は残りの企業を受け付けない", async () => {
  const a = await seed(),
    b = await seed();
  await db.execute(
    sql.raw(
      `create function suspend_prep_actor() returns trigger language plpgsql as $$ begin if NEW.action='audit.requested' and NEW.target_id='${a.c.id}' then update users set status='suspended' where id='${ops.userId}'; end if; return NEW; end $$`,
    ),
  );
  await db.execute(
    sql`create trigger suspend_prep_actor after insert on audit_events for each row execute function suspend_prep_actor()`,
  );
  expect(await requestPreparedAudits(db, clock, ops, [a.input, b.input])).toMatchObject({
    ok: true,
    value: { items: [{ ok: true }, { ok: false }] },
  });
  const rows = await db.select().from(auditRequests);
  expect(rows.map((r) => r.companyId)).toEqual([a.c.id]);
});

it("受付後に別経路の診断が完了した場合も、実行前の照合で新しい採点を止める", async () => {
  const c = await seed();
  expect(await requestPreparedAudits(db, clock, ops, [c.input])).toMatchObject({
    ok: true,
    value: { items: [{ ok: true }] },
  });
  await db
    .insert(siteAudits)
    .values({ companyId: c.c.id, websiteId: c.w.id, targetUrl: c.w.url, status: "evaluated", decision: "hold" });
  expect(await validateAuditRequest(db, { companyId: c.c.id, requestKey: `ops:${c.input.requestId}` })).toContain(
    "別の診断",
  );
});
it("同じ初回依頼の診断履歴はワーカーの再試行を妨げない", async () => {
  const c = await seed();
  await requestPreparedAudits(db, clock, ops, [c.input]);
  const [a] = await db
    .insert(siteAudits)
    .values({ companyId: c.c.id, websiteId: c.w.id, targetUrl: c.w.url, status: "failed" })
    .returning();
  await recordEvent(db, clock, {
    actor: { kind: "system", job: "fixture" },
    action: "site_audit.started",
    targetType: "site_audit",
    targetId: a!.id,
    after: { workerStepKey: auditRequestKey({ id: c.input.requestId, companyId: c.c.id }) },
  });
  expect(await validateAuditRequest(db, { companyId: c.c.id, requestKey: `ops:${c.input.requestId}` })).toBeNull();
});

it("UUIDの大文字小文字を正規化し、実行時にも初回診断の条件を保つ", async () => {
  const c = await seed();
  const input = {
    ...c.input,
    companyId: c.input.companyId.toUpperCase(),
    websiteId: c.input.websiteId.toUpperCase(),
    requestId: c.input.requestId.toUpperCase(),
  };
  expect(await requestPreparedAudits(db, clock, ops, [c.input, input])).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
  expect(await requestPreparedAudits(db, clock, ops, [input])).toMatchObject({
    ok: true,
    value: { items: [{ ok: true }] },
  });
  await db
    .insert(siteAudits)
    .values({ companyId: c.c.id, websiteId: c.w.id, targetUrl: c.w.url, status: "evaluated", decision: "hold" });
  expect(await validateAuditRequest(db, { companyId: c.c.id, requestKey: `ops:${c.input.requestId}` })).toContain(
    "別の診断",
  );
});
