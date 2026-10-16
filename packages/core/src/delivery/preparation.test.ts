import { randomUUID } from "node:crypto";
import { contracts, type Db, deliveryBuilds, deliveryPreparations, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "../common/clock.ts";
import { retryDeliveryBuild } from "./build.ts";
import { createDeliveryForContract, transitionDelivery } from "./delivery.ts";
import { loadDeliveryInputSource, saveDeliveryPreparation } from "./preparation.ts";
import { seedDeliveryBase } from "./test-helpers.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-17T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw Error(r.error);
  return r.value;
}
async function setup() {
  const b = await seedDeliveryBase(db);
  await db.update(contracts).set({ proposalVersionId: null, snapshot: null }).where(eq(contracts.id, b.contract.id));
  const d = must(await createDeliveryForContract(db, clock, b.ops, b.contract.id)).delivery;
  return {
    ...b,
    d,
    input: {
      deliveryId: d.id,
      requestId: randomUUID(),
      expectedRevision: 0,
      proposalVersionId: b.proposalVersion.id,
      scopeText: "契約資料で確認した2ページ",
      reason: "原本と図案を照合",
      confirmed: true as const,
    },
  };
}
it("旧契約は補完前に停止し、確認後は契約を変えずに制作できる", async () => {
  const s = await setup();
  expect(await transitionDelivery(db, clock, s.ops, s.d.id, "building")).toMatchObject({
    ok: false,
    error: "preparation_required",
  });
  const p = must(await saveDeliveryPreparation(db, clock, s.ops, s.input));
  const d = must(await transitionDelivery(db, clock, s.ops, s.d.id, "building"));
  const source = await loadDeliveryInputSource(db, s.d.id, d.currentBuildId!);
  expect(source!.preparation!.id).toBe(p.id);
  expect(source!.scope?.scope).toBe(s.input.scopeText);
  expect(source!.blockers).toEqual([]);
  expect((await db.select().from(contracts))[0]).toMatchObject({ proposalVersionId: null, snapshot: null });
});
it("同じ受付の再送は一件になり、同じ番号の別内容を拒否する", async () => {
  const s = await setup();
  const p = must(await saveDeliveryPreparation(db, clock, s.ops, s.input));
  for (let i = 0; i < 3; i++) expect(must(await saveDeliveryPreparation(db, clock, s.ops, s.input)).id).toBe(p.id);
  expect(await saveDeliveryPreparation(db, clock, s.ops, { ...s.input, scopeText: "別の範囲" })).toMatchObject({
    ok: false,
    error: "request_conflict",
  });
  expect(await db.select().from(deliveryPreparations)).toHaveLength(1);
});
it("古い画面からの上書きと確認チェックなしを拒否する", async () => {
  const s = await setup();
  expect(await saveDeliveryPreparation(db, clock, s.ops, { ...s.input, confirmed: false })).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
  must(await saveDeliveryPreparation(db, clock, s.ops, s.input));
  expect(await saveDeliveryPreparation(db, clock, s.ops, { ...s.input, requestId: randomUUID() })).toMatchObject({
    ok: false,
    error: "conflict",
  });
});
it("停止した制作では新しい補完版を作り、古い制作回の入力は変えない", async () => {
  const s = await setup(),
    p = must(await saveDeliveryPreparation(db, clock, s.ops, s.input)),
    d = must(await transitionDelivery(db, clock, s.ops, s.d.id, "building"));
  expect(
    await saveDeliveryPreparation(db, clock, s.ops, { ...s.input, expectedRevision: 1, requestId: randomUUID() }),
  ).toMatchObject({ ok: false, error: "invalid_state" });
  await db.update(deliveryBuilds).set({ status: "failed" }).where(eq(deliveryBuilds.id, d.currentBuildId!));
  const next = must(
    await saveDeliveryPreparation(db, clock, s.ops, {
      ...s.input,
      expectedRevision: 1,
      requestId: randomUUID(),
      scopeText: "再照合済みの3ページ",
    }),
  );
  const retry = must(await retryDeliveryBuild(db, clock, s.ops, d.id, d.currentBuildId!));
  expect((await loadDeliveryInputSource(db, d.id, d.currentBuildId!))!.preparation!.id).toBe(p.id);
  expect((await loadDeliveryInputSource(db, d.id, retry.buildId))!.preparation!.id).toBe(next.id);
});
it("契約に記録された範囲・価格は補完フォームから変更しない", async () => {
  const s = await setup();
  const snapshot = { version: 1, terms: { price: 321000, scope: { description: "確定範囲" } } };
  await db.update(contracts).set({ snapshot }).where(eq(contracts.id, s.contract.id));
  const p = must(await saveDeliveryPreparation(db, clock, s.ops, s.input));
  expect(p.scope).toEqual(snapshot.terms.scope);
  expect((await db.select().from(contracts))[0]!.snapshot).toEqual(snapshot);
});
it("記録済みの契約や他社の提案を補完操作で差し替えない", async () => {
  const s = await setup(),
    other = await seedDeliveryBase(db);
  expect(
    await saveDeliveryPreparation(db, clock, s.ops, { ...s.input, proposalVersionId: other.proposalVersion.id }),
  ).toMatchObject({ ok: false, error: "not_ready" });
  await db
    .update(contracts)
    .set({ proposalVersionId: s.proposalVersion.id, snapshot: { version: 1, terms: { scope: "確定" } } })
    .where(eq(contracts.id, s.contract.id));
  expect(await saveDeliveryPreparation(db, clock, s.ops, s.input)).toMatchObject({ ok: false, error: "not_needed" });
});
it("範囲だけ不足した契約は元の提案を固定する", async () => {
  const s = await setup();
  await db.update(contracts).set({ proposalVersionId: s.proposalVersion.id }).where(eq(contracts.id, s.contract.id));
  const other = await seedDeliveryBase(db);
  expect(
    await saveDeliveryPreparation(db, clock, s.ops, { ...s.input, proposalVersionId: other.proposalVersion.id }),
  ).toMatchObject({ ok: false, error: "fixed_proposal" });
});
it("営業・停止運営・未完了契約・秘密情報を拒否する", async () => {
  const s = await setup();
  expect(await saveDeliveryPreparation(db, clock, s.sales, s.input)).toMatchObject({ ok: false, error: "forbidden" });
  expect(
    await saveDeliveryPreparation(db, clock, s.ops, { ...s.input, scopeText: "パスワード: example-private-password" }),
  ).toMatchObject({ ok: false, error: "secret_like_value" });
  await db.update(contracts).set({ status: "reported" }).where(eq(contracts.id, s.contract.id));
  expect(await saveDeliveryPreparation(db, clock, s.ops, s.input)).toMatchObject({ ok: false, error: "invalid_state" });
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  expect(await saveDeliveryPreparation(db, clock, s.ops, s.input)).toMatchObject({ ok: false, error: "forbidden" });
});
it("監査保存が失敗したら補完版も巻き戻す", async () => {
  const s = await setup();
  await db.execute(
    sql`create function fail_preparation() returns trigger language plpgsql as $$ begin if NEW.action='delivery.preparation_confirm' then raise exception 'fixture failure'; end if; return NEW; end $$`,
  );
  await db.execute(
    sql`create trigger fail_preparation before insert on audit_events for each row execute function fail_preparation()`,
  );
  await expect(saveDeliveryPreparation(db, clock, s.ops, s.input)).rejects.toThrow();
  expect(await db.select().from(deliveryPreparations)).toHaveLength(0);
});
it("制作回の補完が別納品の記録なら採用しない", async () => {
  const a = await setup(),
    b = await setup();
  const p = must(await saveDeliveryPreparation(db, clock, a.ops, a.input));
  const [run] = await db.insert(deliveryBuilds).values({ deliveryId: b.d.id, preparationId: p.id }).returning();
  expect(await loadDeliveryInputSource(db, b.d.id, run!.id)).toBeNull();
});

it("旧制作の接続切れは不足情報を示して停止し、補完後に新しい回で再開する", async () => {
  const s = await setup();
  await db
    .update(contracts)
    .set({ proposalVersionId: s.proposalVersion.id, snapshot: { version: 1, terms: { scope: "制作範囲" } } })
    .where(eq(contracts.id, s.contract.id));
  const d = must(await transitionDelivery(db, clock, s.ops, s.d.id, "building"));
  await db.update(contracts).set({ proposalVersionId: null, snapshot: null }).where(eq(contracts.id, s.contract.id));
  await db
    .update(deliveryBuilds)
    .set({ status: "running", leaseUntil: clock.now() })
    .where(eq(deliveryBuilds.id, d.currentBuildId!));
  expect(await retryDeliveryBuild(db, clock, s.ops, d.id, d.currentBuildId!)).toMatchObject({
    ok: false,
    error: "preparation_required",
  });
  expect((await db.select().from(deliveryBuilds).where(eq(deliveryBuilds.id, d.currentBuildId!)))[0]!.status).toBe(
    "failed",
  );
  const saved = must(await saveDeliveryPreparation(db, clock, s.ops, s.input));
  const next = must(await retryDeliveryBuild(db, clock, s.ops, d.id, d.currentBuildId!));
  expect((await loadDeliveryInputSource(db, d.id, next.buildId))!.preparation!.id).toBe(saved.id);
  expect((await loadDeliveryInputSource(db, d.id, d.currentBuildId!))!.preparation).toBeNull();
  expect((await loadDeliveryInputSource(db, d.id, d.currentBuildId!))!.blockers.length).toBeGreaterThan(0);
});
