// 運営の納品操作の結合テスト（PGlite）。運営以外は操作できない、顧客確認のURL、一覧（15・18章・AC-18）
import { type Actor, addDeliveryVersion, decideAsCustomer, fixedClock, getCustomerReview } from "@siteoffer/core";
import { CUSTOMER_IMAGE_CONSENT, seedDeliveryBase } from "@siteoffer/core/delivery/testing";
import { type Db, deliveries, deployments } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpsDeps } from "./commands";
import {
  createDeliveryByOps,
  customerReviewUrl,
  listContractsAwaitingDelivery,
  listDeliveryDetails,
  recordPublicationByOps,
  sendToCustomerReviewByOps,
  transitionDeliveryByOps,
} from "./delivery";

let db: Db;
let close: () => Promise<void>;
let deps: OpsDeps;
const clock = fixedClock("2026-10-14T00:00:00Z");
let ops: Actor;
let sales: Actor;
let contractId: string;

const WEB = "http://web.example.test:3100";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  deps = { db, clock };
  clock.set("2026-10-14T00:00:00Z");
  const base = await seedDeliveryBase(db);
  ops = base.ops;
  sales = base.sales;
  contractId = base.contract.id;
}, 30_000);

afterEach(async () => {
  await close();
});

function must<T>(r: { ok: true; value: T } | { ok: false; error: string; message?: string }): T {
  if (!r.ok) throw new Error(`${r.error}: ${r.message ?? ""}`);
  return r.value;
}

/** ワーカーの代わりに版を1つ追加する（ワーカーは system として addDeliveryVersion を呼ぶ想定） */
async function workerBuilds(deliveryId: string) {
  return must(
    await addDeliveryVersion(db, clock, { kind: "system", job: "test-build" }, deliveryId, {
      artifactDir: "/artifacts/delivery/v1",
    }),
  );
}

describe("顧客確認URL", () => {
  it("<web>/review/<token> の形で、末尾のスラッシュを重ねない", () => {
    const t = "t".repeat(43);
    expect(customerReviewUrl("http://localhost:3100", t)).toBe(`http://localhost:3100/review/${t}`);
    expect(customerReviewUrl("http://localhost:3100//", t)).toBe(`http://localhost:3100/review/${t}`);
  });
});

describe("納品の操作（運営）", () => {
  it("作成 → 制作 → 版（ワーカー）→ 運営確認 → 顧客確認URL → 顧客の承認 → 公開の記録 → 納品", async () => {
    expect(must(await listContractsAwaitingDelivery(db, ops)).map((c) => c.contractId)).toEqual([contractId]);
    const { deliveryId, created } = must(await createDeliveryByOps(deps, ops, contractId));
    expect(created).toBe(true);
    // 二重に作らない
    expect(must(await createDeliveryByOps(deps, ops, contractId))).toEqual({ deliveryId, created: false });
    expect(must(await listContractsAwaitingDelivery(db, ops))).toHaveLength(0);

    must(await transitionDeliveryByOps(deps, ops, { deliveryId, to: "building" }));
    // 版がないと運営確認に回せない
    expect(await transitionDeliveryByOps(deps, ops, { deliveryId, to: "ops_review" })).toMatchObject({
      ok: false,
      error: "no_version",
    });
    const v1 = await workerBuilds(deliveryId);
    must(await transitionDeliveryByOps(deps, ops, { deliveryId, to: "ops_review" }));

    const sent = must(await sendToCustomerReviewByOps(deps, ops, { deliveryId, versionId: v1.id, ttlHours: 72 }, WEB));
    const m = sent.reviewUrl.match(/^http:\/\/web\.example\.test:3100\/review\/([A-Za-z0-9_-]{43})$/);
    expect(m).not.toBeNull();
    const token = m![1]!;
    // 顧客確認の画面がこのトークンで開ける（顧客確認中の版）
    const review = await getCustomerReview(db, clock, token);
    expect(review.ok).toBe(true);

    must(
      await decideAsCustomer(db, clock, token, {
        versionId: v1.id,
        decision: "approved",
        imageRightsConsent: CUSTOMER_IMAGE_CONSENT,
        comment: "問題ありません",
      }),
    );
    const [afterApprove] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
    expect(afterApprove!.status).toBe("ready");
    expect(afterApprove!.lockedVersionId).toBe(v1.id);

    // 一覧で顧客の判断が見える
    const detail = must(await listDeliveryDetails(db, ops)).find((d) => d.delivery.id === deliveryId)!;
    expect(detail.approvals.map((a) => [a.decision, a.comment])).toEqual([["approved", "問題ありません"]]);

    must(await recordPublicationByOps(deps, ops, { deliveryId, environment: "production", url: null }));
    const deps_ = await db.select().from(deployments).where(eq(deployments.deliveryId, deliveryId));
    expect(deps_.map((d) => d.status)).toEqual(["recorded"]);
    must(await transitionDeliveryByOps(deps, ops, { deliveryId, to: "delivered" }));
    const [done] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
    expect(done!.status).toBe("delivered");
  });

  it("顧客の修正依頼は制作に戻り、コメントが一覧に出る", async () => {
    const { deliveryId } = must(await createDeliveryByOps(deps, ops, contractId));
    must(await transitionDeliveryByOps(deps, ops, { deliveryId, to: "building" }));
    const v1 = await workerBuilds(deliveryId);
    must(await transitionDeliveryByOps(deps, ops, { deliveryId, to: "ops_review" }));
    const sent = must(await sendToCustomerReviewByOps(deps, ops, { deliveryId, versionId: v1.id }, WEB));
    const token = sent.reviewUrl.split("/review/")[1]!;
    must(
      await decideAsCustomer(db, clock, token, {
        versionId: v1.id,
        decision: "changes_requested",
        comment: "電話番号を大きく",
      }),
    );
    const detail = must(await listDeliveryDetails(db, ops)).find((d) => d.delivery.id === deliveryId)!;
    expect(detail.delivery.status).toBe("building");
    expect(detail.approvals[0]).toMatchObject({
      deliveryVersionId: v1.id,
      decision: "changes_requested",
      comment: "電話番号を大きく",
    });
  });

  it("営業・未ログイン・system（画面の入口）は納品を操作・閲覧できない（AC-18）", async () => {
    const system: Actor = { kind: "system", job: "x" };
    for (const a of [sales, null, system]) {
      expect(await createDeliveryByOps(deps, a, contractId)).toMatchObject({ ok: false, error: "forbidden" });
      expect(await listContractsAwaitingDelivery(db, a)).toMatchObject({ ok: false, error: "forbidden" });
      expect(await listDeliveryDetails(db, a)).toMatchObject({ ok: false, error: "forbidden" });
    }
    expect(await db.select().from(deliveries)).toHaveLength(0);

    const { deliveryId } = must(await createDeliveryByOps(deps, ops, contractId));
    for (const a of [sales, null]) {
      expect(await transitionDeliveryByOps(deps, a, { deliveryId, to: "building" })).toMatchObject({
        ok: false,
        error: "forbidden",
      });
    }
    must(await transitionDeliveryByOps(deps, ops, { deliveryId, to: "building" }));
    const v1 = await workerBuilds(deliveryId);
    must(await transitionDeliveryByOps(deps, ops, { deliveryId, to: "ops_review" }));
    expect(await sendToCustomerReviewByOps(deps, sales, { deliveryId, versionId: v1.id }, WEB)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await recordPublicationByOps(deps, sales, { deliveryId, environment: "production" })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    const [row] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
    expect(row!.status).toBe("ops_review");
  });

  it("画面から来た不正な行き先・契約完了前の契約は断る", async () => {
    const { deliveryId } = must(await createDeliveryByOps(deps, ops, contractId));
    expect(await transitionDeliveryByOps(deps, ops, { deliveryId, to: "ready" })).toMatchObject({
      ok: false,
      error: "invalid_transition",
    });
    expect(await transitionDeliveryByOps(deps, ops, { deliveryId, to: "published" })).toMatchObject({
      ok: false,
      error: "invalid_transition",
    });
    const pending = await seedDeliveryBase(db, { contractStatus: "reported" });
    expect(await createDeliveryByOps(deps, ops, pending.contract.id)).toMatchObject({
      ok: false,
      error: "contract_not_completed",
    });
    expect(must(await listContractsAwaitingDelivery(db, ops))).toHaveLength(0);
  });
});
