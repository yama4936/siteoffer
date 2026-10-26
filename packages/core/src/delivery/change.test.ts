import { randomUUID } from "node:crypto";
import { auditEvents, contracts, type Db, deliveries, deliveryBuilds, deliveryChanges, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "../common/clock.ts";
import { hasPublishedSite } from "../content.ts";
import { issueShareLink, verifyShareLink } from "../share-link/share-link.ts";
import { requestDeliveryChange } from "./change.ts";
import { decideAsCustomer } from "./customer.ts";
import {
  addDeliveryVersion,
  createDeliveryForContract,
  getDeliveryDetail,
  recordPublication,
  sendToCustomerReview,
  transitionDelivery,
} from "./delivery.ts";
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
async function setup(status: "ready" | "published" | "delivered" = "ready") {
  const b = await seedDeliveryBase(db),
    d = must(await createDeliveryForContract(db, clock, b.ops, b.contract.id)).delivery;
  must(await transitionDelivery(db, clock, b.ops, d.id, "building"));
  const v = must(await addDeliveryVersion(db, clock, b.ops, d.id, { artifactDir: "/fixture/approved" }));
  must(await transitionDelivery(db, clock, b.ops, d.id, "ops_review"));
  const sent = must(await sendToCustomerReview(db, clock, b.ops, d.id, { versionId: v.id }));
  must(await decideAsCustomer(db, clock, sent.issued.token, { versionId: v.id, decision: "approved" }));
  if (status !== "ready")
    must(await recordPublication(db, clock, b.ops, d.id, { environment: "fixture", url: "https://example.test" }));
  if (status === "delivered") must(await transitionDelivery(db, clock, b.ops, d.id, "delivered"));
  return {
    ...b,
    d,
    v,
    token: sent.issued.token,
    input: {
      deliveryId: d.id,
      fromVersionId: v.id,
      expectedStatus: status,
      requestId: randomUUID(),
      reason: "顧客と修正範囲を確認済み",
      requestedChanges: "外観写真を差し替える",
      confirmed: true as const,
    },
  };
}
it.each(["ready", "published", "delivered"] as const)(
  "%sから再制作・再承認し、過去の承認と公開履歴を保持する",
  async (status) => {
    const s = await setup(status),
      before = must(await getDeliveryDetail(db, s.ops, s.d.id));
    const saved = must(await requestDeliveryChange(db, clock, s.ops, s.input));
    const detail = must(await getDeliveryDetail(db, s.ops, s.d.id));
    expect(detail.delivery).toMatchObject({
      status: "info_gathering",
      lockedVersionId: null,
      reviewVersionId: null,
      currentBuildId: null,
    });
    expect(detail.approvals).toEqual(before.approvals);
    expect(await hasPublishedSite(db, s.company.id)).toBe(status !== "ready");
    expect(detail.versions).toEqual(before.versions);
    expect(detail.deployments).toEqual(before.deployments);
    expect((await verifyShareLink(db, clock, s.token)).ok).toBe(false);
    expect(
      (
        await issueShareLink(db, clock, s.ops, {
          purpose: "delivery",
          targetId: s.v.id,
          ttlHours: 24,
        })
      ).ok,
    ).toBe(false);
    const building = must(await transitionDelivery(db, clock, s.ops, s.d.id, "building"));
    expect(
      (await db.select().from(deliveryBuilds).where(eq(deliveryBuilds.id, building.currentBuildId!)))[0]!.changeId,
    ).toBe(saved.id);
    const v2 = must(await addDeliveryVersion(db, clock, s.ops, s.d.id, { artifactDir: "/fixture/changed" }));
    must(await transitionDelivery(db, clock, s.ops, s.d.id, "ops_review"));
    const next = must(await sendToCustomerReview(db, clock, s.ops, s.d.id, { versionId: v2.id }));
    must(await decideAsCustomer(db, clock, next.issued.token, { versionId: v2.id, decision: "approved" }));
    const done = must(await getDeliveryDetail(db, s.ops, s.d.id));
    expect(done.changes[0]).toMatchObject({ id: saved.id, approvedVersionId: v2.id, approvedAt: clock.now() });
    expect(done.approvals).toHaveLength(2);
    expect(done.delivery.lockedVersionId).toBe(v2.id);
    expect((await verifyShareLink(db, clock, s.token)).ok).toBe(false);
    expect(must(await requestDeliveryChange(db, clock, s.ops, s.input))).toEqual({
      id: saved.id,
      alreadyRecorded: true,
    });
    expect(must(await getDeliveryDetail(db, s.ops, s.d.id)).delivery.lockedVersionId).toBe(v2.id);
    const second = must(
      await requestDeliveryChange(db, clock, s.ops, {
        ...s.input,
        fromVersionId: v2.id,
        expectedStatus: "ready",
        requestId: randomUUID(),
      }),
    );
    expect(second.id).not.toBe(saved.id);
  },
);
it("同じ受付は一件、別内容の再送・古い画面・確認なしを拒否する", async () => {
  const s = await setup();
  expect(await requestDeliveryChange(db, clock, s.ops, { ...s.input, confirmed: false })).toMatchObject({
    ok: false,
    error: "invalid_input",
  });
  expect(await requestDeliveryChange(db, clock, s.ops, { ...s.input, expectedStatus: "published" })).toMatchObject({
    ok: false,
    error: "conflict",
  });
  const saved = must(await requestDeliveryChange(db, clock, s.ops, s.input));
  for (let i = 0; i < 3; i++) expect(must(await requestDeliveryChange(db, clock, s.ops, s.input)).id).toBe(saved.id);
  expect(await requestDeliveryChange(db, clock, s.ops, { ...s.input, requestedChanges: "別の内容" })).toMatchObject({
    ok: false,
    error: "request_conflict",
  });
  expect(await requestDeliveryChange(db, clock, s.ops, { ...s.input, requestId: randomUUID() })).toMatchObject({
    ok: false,
    error: "conflict",
  });
  expect(await db.select().from(deliveryChanges)).toHaveLength(1);
  expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "delivery.change_request"))).toHaveLength(1);
});
it("営業・停止運営・未完了契約・他納品の版・秘密情報を拒否する", async () => {
  const s = await setup(),
    other = await setup();
  expect(await requestDeliveryChange(db, clock, s.sales, s.input)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await requestDeliveryChange(db, clock, s.ops, { ...s.input, fromVersionId: other.v.id })).toMatchObject({
    ok: false,
    error: "conflict",
  });
  expect(
    await requestDeliveryChange(db, clock, s.ops, { ...s.input, reason: "パスワード: example-private-password" }),
  ).toMatchObject({ ok: false, error: "secret_like_value" });
  await db.update(contracts).set({ status: "reported" }).where(eq(contracts.id, s.contract.id));
  expect(await requestDeliveryChange(db, clock, s.ops, s.input)).toMatchObject({ ok: false, error: "invalid_state" });
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  expect(await requestDeliveryChange(db, clock, s.ops, s.input)).toMatchObject({ ok: false, error: "forbidden" });
});
it("監査保存の失敗で変更受付・共有停止・状態をすべて巻き戻す", async () => {
  const s = await setup();
  await db.execute(
    sql`create function fail_change() returns trigger language plpgsql as $$ begin if NEW.action='delivery.change_request' then raise exception 'fixture failure'; end if; return NEW; end $$`,
  );
  await db.execute(
    sql`create trigger fail_change before insert on audit_events for each row execute function fail_change()`,
  );
  await expect(requestDeliveryChange(db, clock, s.ops, s.input)).rejects.toThrow();
  expect(await db.select().from(deliveryChanges)).toHaveLength(0);
  expect((await db.select().from(deliveries))[0]).toMatchObject({ status: "ready", lockedVersionId: s.v.id });
  expect((await verifyShareLink(db, clock, s.token)).ok).toBe(true);
});
it("顧客が再修正を依頼した制作回も同じ変更受付に結びつく", async () => {
  const s = await setup(),
    change = must(await requestDeliveryChange(db, clock, s.ops, s.input));
  must(await transitionDelivery(db, clock, s.ops, s.d.id, "building"));
  const v = must(await addDeliveryVersion(db, clock, s.ops, s.d.id, { artifactDir: "/fixture/revision" }));
  must(await transitionDelivery(db, clock, s.ops, s.d.id, "ops_review"));
  const sent = must(await sendToCustomerReview(db, clock, s.ops, s.d.id, { versionId: v.id }));
  const decided = must(
    await decideAsCustomer(db, clock, sent.issued.token, {
      versionId: v.id,
      decision: "changes_requested",
      comment: "写真をもう少し大きく",
    }),
  );
  expect(
    (await db.select().from(deliveryBuilds).where(eq(deliveryBuilds.id, decided.delivery.currentBuildId!)))[0]!
      .changeId,
  ).toBe(change.id);
  expect((await db.select().from(deliveryChanges))[0]!.approvedVersionId).toBeNull();
});

it("承認版より番号が新しくても、変更受付前に追加された未承認の版は再共有しない", async () => {
  const s = await setup();
  const extra = must(await addDeliveryVersion(db, clock, s.ops, s.d.id, { artifactDir: "/fixture/old-extra" }));
  const old = must(await issueShareLink(db, clock, s.ops, { purpose: "delivery", targetId: extra.id, ttlHours: 24 }));
  must(await requestDeliveryChange(db, clock, s.ops, s.input));
  expect((await verifyShareLink(db, clock, old.token)).ok).toBe(false);
  expect(
    await issueShareLink(db, clock, s.ops, { purpose: "delivery", targetId: extra.id, ttlHours: 24 }),
  ).toMatchObject({ ok: false, error: "target_not_found" });
});
