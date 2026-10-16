import { randomUUID } from "node:crypto";
import { approvals, auditEvents, type Db, deliveries } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "../common/clock.ts";
import { revokeShareLink } from "../share-link/share-link.ts";
import { decideAsCustomer } from "./customer.ts";
import { addDeliveryVersion, createDeliveryForContract, sendToCustomerReview, transitionDelivery } from "./delivery.ts";
import { seedDeliveryBase } from "./test-helpers.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-16T00:00:00Z");
function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw Error(r.error);
  return r.value;
}
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock.set("2026-10-16T00:00:00Z");
});
afterEach(async () => {
  await close();
});
async function seed() {
  const b = await seedDeliveryBase(db);
  const { delivery } = must(await createDeliveryForContract(db, clock, b.ops, b.contract.id));
  must(await transitionDelivery(db, clock, b.ops, delivery.id, "building"));
  const v = must(await addDeliveryVersion(db, clock, b.ops, delivery.id, { artifactDir: "/fixture/v1" }));
  must(await transitionDelivery(db, clock, b.ops, delivery.id, "ops_review"));
  const { issued } = must(await sendToCustomerReview(db, clock, b.ops, delivery.id, { versionId: v.id }));
  return { ...b, delivery, v, issued };
}
it("並行再送は同じ受付結果を返し、修正依頼・操作履歴を1件だけ作る", async () => {
  const b = await seed(),
    request = {
      versionId: b.v.id,
      decision: "changes_requested" as const,
      comment: "問い合わせの導線を目立たせたい",
      requestKey: randomUUID(),
    };
  const results = await Promise.all(
    Array.from({ length: 3 }, () => decideAsCustomer(db, clock, b.issued.token, request)),
  );
  const first = must(results[0]!);
  for (const r of results) expect(must(r).approvalId).toBe(first.approvalId);
  expect(await db.select().from(approvals)).toHaveLength(1);
  const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "delivery.customer_request_changes"));
  expect(events).toHaveLength(1);
  for (const value of [request.comment, request.requestKey, b.issued.token])
    expect(JSON.stringify(events)).not.toContain(value);
  expect(JSON.stringify(await db.select().from(approvals))).not.toContain(request.requestKey);
});
it("承認の応答消失は同じ結果へ復旧し、異なる判断・本文の同じ受付キーは拒否する", async () => {
  const b = await seed(),
    request = { versionId: b.v.id, decision: "approved" as const, comment: "確認しました", requestKey: randomUUID() };
  const first = must(await decideAsCustomer(db, clock, b.issued.token, request));
  expect(must(await decideAsCustomer(db, clock, b.issued.token, request)).approvalId).toBe(first.approvalId);
  for (const change of [{ comment: "違う内容" }, { decision: "changes_requested" as const }])
    expect(await decideAsCustomer(db, clock, b.issued.token, { ...request, ...change })).toMatchObject({
      ok: false,
      error: "request_conflict",
    });
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, b.delivery.id));
  expect(d!.lockedVersionId).toBe(b.v.id);
});
it("新しい制作回が進んでも古い送信を再実行せず、受付済みだけ確認する", async () => {
  const b = await seed(),
    request = {
      versionId: b.v.id,
      decision: "changes_requested" as const,
      comment: "調整依頼",
      requestKey: randomUUID(),
    };
  must(await decideAsCustomer(db, clock, b.issued.token, request));
  clock.advance(1000);
  const v2 = must(await addDeliveryVersion(db, clock, b.ops, b.delivery.id, { artifactDir: "/fixture/v2" }));
  must(await transitionDelivery(db, clock, b.ops, b.delivery.id, "ops_review"));
  must(await sendToCustomerReview(db, clock, b.ops, b.delivery.id, { versionId: v2.id }));
  expect(must(await decideAsCustomer(db, clock, b.issued.token, request)).delivery.reviewVersionId).toBe(v2.id);
  expect(await db.select().from(approvals)).toHaveLength(1);
});
it("別リンク・期限切れ・取り消し済みリンクで受付結果を取得しない", async () => {
  const b = await seed(),
    second = must(await sendToCustomerReview(db, clock, b.ops, b.delivery.id, { versionId: b.v.id }));
  const request = { versionId: b.v.id, decision: "approved" as const, requestKey: randomUUID() };
  must(await decideAsCustomer(db, clock, b.issued.token, request));
  expect(await decideAsCustomer(db, clock, second.issued.token, request)).toMatchObject({
    ok: false,
    error: "not_under_review",
  });
  must(await revokeShareLink(db, clock, b.ops, b.issued.link.id));
  expect(await decideAsCustomer(db, clock, b.issued.token, request)).toMatchObject({
    ok: false,
    error: "link_invalid",
  });
  clock.set(second.issued.link.expiresAt);
  expect(await decideAsCustomer(db, clock, second.issued.token, request)).toMatchObject({
    ok: false,
    error: "link_invalid",
  });
});
it("修正前の版をそのまま、またはもっと古い版を顧客確認へ戻せない", async () => {
  const b = await seed();
  must(
    await decideAsCustomer(db, clock, b.issued.token, {
      versionId: b.v.id,
      decision: "changes_requested",
      comment: "修正",
    }),
  );
  must(await transitionDelivery(db, clock, b.ops, b.delivery.id, "ops_review"));
  expect(await sendToCustomerReview(db, clock, b.ops, b.delivery.id, { versionId: b.v.id })).toMatchObject({
    ok: false,
    error: "version_requires_revision",
  });
  must(await transitionDelivery(db, clock, b.ops, b.delivery.id, "building"));
  const v2 = must(await addDeliveryVersion(db, clock, b.ops, b.delivery.id, { artifactDir: "/fixture/v2" }));
  must(await transitionDelivery(db, clock, b.ops, b.delivery.id, "ops_review"));
  const review = must(await sendToCustomerReview(db, clock, b.ops, b.delivery.id, { versionId: v2.id }));
  must(
    await decideAsCustomer(db, clock, review.issued.token, {
      versionId: v2.id,
      decision: "changes_requested",
      comment: "もう一度修正",
    }),
  );
  must(await transitionDelivery(db, clock, b.ops, b.delivery.id, "ops_review"));
  for (const versionId of [b.v.id, v2.id])
    expect(await sendToCustomerReview(db, clock, b.ops, b.delivery.id, { versionId })).toMatchObject({
      ok: false,
      error: "version_requires_revision",
    });
});
it("秘密情報・不正な受付値を保存せず、途中失敗では承認と納品状態をまとめて戻す", async () => {
  const b = await seed();
  for (const patch of [{ comment: "password=fixture12345" }, { requestKey: "invalid" }])
    expect(
      await decideAsCustomer(db, clock, b.issued.token, { versionId: b.v.id, decision: "approved", ...patch }),
    ).toMatchObject({ ok: false, error: "invalid_input" });
  await db.execute(
    sql`create function fail_customer_audit() returns trigger language plpgsql as $$ begin raise exception 'fixture'; end $$`,
  );
  await db.execute(
    sql`create trigger fail_customer before insert on audit_events for each row execute function fail_customer_audit()`,
  );
  await expect(
    decideAsCustomer(db, clock, b.issued.token, { versionId: b.v.id, decision: "approved", requestKey: randomUUID() }),
  ).rejects.toThrow();
  expect(await db.select().from(approvals)).toHaveLength(0);
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, b.delivery.id));
  expect(d!.status).toBe("customer_review");
  expect(d!.lockedVersionId).toBeNull();
});
