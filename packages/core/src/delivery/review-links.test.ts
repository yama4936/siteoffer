import { randomBytes, randomUUID } from "node:crypto";
import { approvals, auditEvents, type Db, deliveries, shareLinks, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "../common/clock.ts";
import { verifyShareLink } from "../share-link/share-link.ts";
import { createShareTokenRecovery } from "../share-link/token.ts";
import { decideAsCustomer } from "./customer.ts";
import { addDeliveryVersion, createDeliveryForContract, sendToCustomerReview, transitionDelivery } from "./delivery.ts";
import { listCustomerReviewLinks, recoverCustomerReviewLink, revokeCustomerReviewLink } from "./review-links.ts";
import { CUSTOMER_IMAGE_CONSENT, seedDeliveryBase } from "./test-helpers.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-16T00:00:00Z"),
  secret = randomBytes(32).toString("base64url"),
  recovery = createShareTokenRecovery(secret);
function must<T extends { ok: true; value: unknown } | { ok: false; error: string }>(
  r: T,
): Extract<T, { ok: true }>["value"] {
  if (!r.ok) throw Error(r.error);
  return r.value as Extract<T, { ok: true }>["value"];
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
  const v = must(await addDeliveryVersion(db, clock, b.ops, delivery.id, { artifactDir: "/fixture/review" }));
  must(await transitionDelivery(db, clock, b.ops, delivery.id, "ops_review"));
  return { ...b, deliveryId: delivery.id, v };
}
async function send(b: Awaited<ReturnType<typeof seed>>, requestKey = randomUUID(), ttlHours = 72) {
  return must(
    await sendToCustomerReview(db, clock, b.ops, b.deliveryId, { versionId: b.v.id, ttlHours, requestKey }, recovery),
  );
}
it("並行する同じ発行は1件で、応答消失後も期限と監査記録を増やさず同じURLを復旧する", async () => {
  const b = await seed(),
    key = randomUUID();
  const results = await Promise.all([1, 2, 3].map(() => send(b, key)));
  const first = results[0]!;
  expect(new Set(results.map((r) => r.issued.token)).size).toBe(1);
  expect(await db.select().from(shareLinks)).toHaveLength(1);
  expect(
    await db.select().from(auditEvents).where(eq(auditEvents.action, "delivery.customer_review_start")),
  ).toHaveLength(1);
  expect(
    await db.select().from(auditEvents).where(eq(auditEvents.action, "delivery.customer_review_reissue")),
  ).toHaveLength(0);
  clock.advance(3600000);
  const again = await send(b, key);
  expect(again.delivery.updatedAt).toEqual(first.delivery.updatedAt);
  expect(again.issued.link.expiresAt).toEqual(first.issued.link.expiresAt);
  const recovered = must(
    await recoverCustomerReviewLink(
      db,
      clock,
      b.ops,
      b.deliveryId,
      first.issued.link.id,
      createShareTokenRecovery(secret),
    ),
  );
  expect(recovered.token).toBe(first.issued.token);
  const saved = JSON.stringify([
    await db.select().from(shareLinks),
    await db.select().from(auditEvents),
    await listCustomerReviewLinks(db, clock, b.ops, b.deliveryId),
  ]);
  for (const hidden of [first.issued.token, secret, key]) expect(saved).not.toContain(hidden);
});
it("同じ受付キーで内容を変更できず、意図した新規発行だけが別リンクになる", async () => {
  const b = await seed(),
    key = randomUUID(),
    first = await send(b, key);
  expect(
    await sendToCustomerReview(
      db,
      clock,
      b.ops,
      b.deliveryId,
      { versionId: b.v.id, ttlHours: 24, requestKey: key },
      recovery,
    ),
  ).toMatchObject({ ok: false, error: "request_conflict" });
  const second = await send(b);
  expect(second.issued.token).not.toBe(first.issued.token);
  expect(await db.select().from(shareLinks)).toHaveLength(2);
  expect((await verifyShareLink(db, clock, first.issued.token)).ok).toBe(true);
  expect(
    await db.select().from(auditEvents).where(eq(auditEvents.action, "delivery.customer_review_reissue")),
  ).toHaveLength(1);
});
it("本人だけが再表示でき、運営は他の運営のリンクを取り消せるが別納品のIDは受け付けない", async () => {
  const a = await seed(),
    b = await seed(),
    sent = await send(a),
    id = sent.issued.link.id;
  expect((await recoverCustomerReviewLink(db, clock, b.ops, a.deliveryId, id, recovery)).ok).toBe(false);
  expect((await recoverCustomerReviewLink(db, clock, a.ops, b.deliveryId, id, recovery)).ok).toBe(false);
  expect((await revokeCustomerReviewLink(db, clock, b.ops, b.deliveryId, id)).ok).toBe(false);
  expect(must(await listCustomerReviewLinks(db, clock, b.ops, a.deliveryId)).links[0]?.own).toBe(false);
  for (const actor of [null, a.sales, { kind: "ops" as const, userId: a.sales.userId }]) {
    expect((await recoverCustomerReviewLink(db, clock, actor, a.deliveryId, id, recovery)).ok).toBe(false);
    expect((await revokeCustomerReviewLink(db, clock, actor, a.deliveryId, id)).ok).toBe(false);
    expect((await listCustomerReviewLinks(db, clock, actor, a.deliveryId)).ok).toBe(false);
  }
  must(await revokeCustomerReviewLink(db, clock, b.ops, a.deliveryId, id));
  must(await revokeCustomerReviewLink(db, clock, b.ops, a.deliveryId, id));
  expect((await verifyShareLink(db, clock, sent.issued.token)).ok).toBe(false);
  expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "share_link.revoke"))).toHaveLength(1);
  expect(
    (
      await decideAsCustomer(db, clock, sent.issued.token, {
        versionId: a.v.id,
        decision: "approved",
        imageRightsConsent: CUSTOMER_IMAGE_CONSENT,
      })
    ).ok,
  ).toBe(false);
});
it("期限切れ・鍵の変更・利用停止・顧客確認の終了では再表示せず、取り消しは過去の判断を消さない", async () => {
  const b = await seed(),
    sent = await send(b),
    id = sent.issued.link.id;
  expect(
    (
      await recoverCustomerReviewLink(
        db,
        clock,
        b.ops,
        b.deliveryId,
        id,
        createShareTokenRecovery(randomBytes(32).toString("base64url")),
      )
    ).ok,
  ).toBe(false);
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, b.ops.userId));
  expect((await recoverCustomerReviewLink(db, clock, b.ops, b.deliveryId, id, recovery)).ok).toBe(false);
  await db.update(users).set({ status: "active" }).where(eq(users.id, b.ops.userId));
  must(
    await decideAsCustomer(db, clock, sent.issued.token, {
      versionId: b.v.id,
      decision: "approved",
      imageRightsConsent: CUSTOMER_IMAGE_CONSENT,
    }),
  );
  expect(await recoverCustomerReviewLink(db, clock, b.ops, b.deliveryId, id, recovery)).toMatchObject({
    ok: false,
    error: "not_under_review",
  });
  expect(must(await listCustomerReviewLinks(db, clock, b.ops, b.deliveryId)).links[0]?.state).toBe("closed");
  must(await revokeCustomerReviewLink(db, clock, b.ops, b.deliveryId, id));
  expect(await db.select().from(approvals)).toHaveLength(1);
  expect((await db.select().from(deliveries).where(eq(deliveries.id, b.deliveryId)))[0]?.lockedVersionId).toBe(b.v.id);
  const second = await seed(),
    expired = await send(second, randomUUID(), 1);
  clock.advance(3600000);
  expect(
    (await recoverCustomerReviewLink(db, clock, second.ops, second.deliveryId, expired.issued.link.id, recovery)).ok,
  ).toBe(false);
  expect(must(await listCustomerReviewLinks(db, clock, second.ops, second.deliveryId)).links[0]?.state).toBe("expired");
});
it("納品のロック待ちで有効期限を過ぎた判断を確定しない", async () => {
  const b = await seed(),
    sent = await send(b, randomUUID(), 1);
  let reads = 0;
  const advancing = { now: () => (++reads === 1 ? clock.now() : new Date(clock.now().getTime() + 3600001)) };
  expect(
    await decideAsCustomer(db, advancing, sent.issued.token, {
      versionId: b.v.id,
      decision: "approved",
      imageRightsConsent: CUSTOMER_IMAGE_CONSENT,
    }),
  ).toMatchObject({ ok: false, error: "link_invalid" });
  expect(await db.select().from(approvals)).toHaveLength(0);
});
it("履歴を20件ずつ取得し、旧形式は再表示不可として区別する", async () => {
  const b = await seed();
  const old = must(await sendToCustomerReview(db, clock, b.ops, b.deliveryId, { versionId: b.v.id }));
  for (let i = 0; i < 20; i++) {
    clock.advance(1000);
    await send(b);
  }
  const first = must(await listCustomerReviewLinks(db, clock, b.ops, b.deliveryId));
  expect(first).toMatchObject({ total: 21, page: 1, pages: 2 });
  expect(first.links).toHaveLength(20);
  const last = must(await listCustomerReviewLinks(db, clock, b.ops, b.deliveryId, 999));
  expect(last.page).toBe(2);
  expect(last.links).toMatchObject([{ id: old.issued.link.id, recoverable: false }]);
  expect((await recoverCustomerReviewLink(db, clock, b.ops, b.deliveryId, old.issued.link.id, recovery)).ok).toBe(
    false,
  );
  expect(JSON.stringify(first)).not.toContain("tokenHash");
  expect(JSON.stringify(first)).not.toContain("recoveryKeyId");
});
it("監査記録が失敗した場合はリンクの発行と状態遷移を一緒に戻す", async () => {
  const b = await seed(),
    key = randomUUID();
  await db.execute(
    sql`create function fail_review_event() returns trigger language plpgsql as $$ begin if NEW.action = 'delivery.customer_review_start' then raise exception 'fixture'; end if; return NEW; end $$`,
  );
  await db.execute(
    sql`create trigger fail_review_event before insert on audit_events for each row execute function fail_review_event()`,
  );
  await expect(send(b, key)).rejects.toThrow();
  expect(await db.select().from(shareLinks)).toHaveLength(0);
  expect((await db.select().from(deliveries).where(eq(deliveries.id, b.deliveryId)))[0]?.status).toBe("ops_review");
  await db.execute(sql`drop trigger fail_review_event on audit_events`);
  await send(b, key);
  expect(await db.select().from(shareLinks)).toHaveLength(1);
});
