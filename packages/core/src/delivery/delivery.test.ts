// 納品・顧客確認の結合テスト（PGlite）。15・18章、AC-18。
import {
  approvals,
  auditEvents,
  type Db,
  deliveries,
  deliveryVersions,
  deployments,
  generationJobs,
  shareLinks,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../common/actor.ts";
import { fixedClock, HOUR } from "../common/clock.ts";
import { issueShareLink, revokeShareLink } from "../share-link/share-link.ts";
import { seedProposalVersion } from "../share-link/test-helpers.ts";
import { decideAsCustomer, getCustomerReview } from "./customer.ts";
import {
  addDeliveryVersion,
  canTransition,
  createDeliveryForContract,
  DELIVERY_STATUSES,
  getDeliveryDetail,
  recordPublication,
  sendToCustomerReview,
  transitionDelivery,
} from "./delivery.ts";
import { seedDeliveryBase } from "./test-helpers.ts";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-14T00:00:00Z");
let ops: Actor;
let sales: Actor;
let contractId: string;
let companyId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock.set("2026-10-14T00:00:00Z");
  const base = await seedDeliveryBase(db);
  ops = base.ops;
  sales = base.sales;
  contractId = base.contract.id;
  companyId = base.company.id;
  // マイグレーションの適用に時間がかかることがある（共有マシンの負荷）。既定の10秒では足りない場合に備える
}, 30_000);

afterEach(async () => {
  await close();
});

function must<T>(r: { ok: true; value: T } | { ok: false; error: string; message?: string }): T {
  if (!r.ok) throw new Error(`${r.error}: ${r.message ?? ""}`);
  return r.value;
}

/** 納品を作り、制作版を1つ追加して運営確認まで進める */
async function deliveryInOpsReview(artifactDir = "/artifacts/delivery/v1") {
  const { delivery } = must(await createDeliveryForContract(db, clock, ops, contractId));
  must(await transitionDelivery(db, clock, ops, delivery.id, "building"));
  const v1 = must(await addDeliveryVersion(db, clock, ops, delivery.id, { artifactDir }));
  must(await transitionDelivery(db, clock, ops, delivery.id, "ops_review"));
  return { deliveryId: delivery.id, v1 };
}

/** 顧客確認まで進め、リンクのトークンを返す */
async function deliveryInCustomerReview() {
  const { deliveryId, v1 } = await deliveryInOpsReview();
  const sent = must(await sendToCustomerReview(db, clock, ops, deliveryId, { versionId: v1.id, ttlHours: 72 }));
  return { deliveryId, v1, token: sent.issued.token, linkId: sent.issued.link.id };
}

async function loadDelivery(id: string) {
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, id));
  return d!;
}

describe("状態遷移の表", () => {
  it("18章の順に進み、戻りは運営確認・顧客確認から制作へだけ", () => {
    const forward = DELIVERY_STATUSES;
    for (let i = 0; i + 1 < forward.length; i++) expect(canTransition(forward[i]!, forward[i + 1]!)).toBe(true);
    expect(canTransition("ops_review", "building")).toBe(true);
    expect(canTransition("customer_review", "building")).toBe(true);
    // 飛ばし・公開準備以降の戻りは不可
    expect(canTransition("info_gathering", "ops_review")).toBe(false);
    expect(canTransition("building", "customer_review")).toBe(false);
    expect(canTransition("ready", "building")).toBe(false);
    expect(canTransition("ready", "customer_review")).toBe(false);
    expect(canTransition("published", "ready")).toBe(false);
    expect(canTransition("delivered", "building")).toBe(false);
  });
});

describe("納品の作成", () => {
  it("完了した契約に1件だけ作られ、2回目は既存を返す", async () => {
    const first = must(await createDeliveryForContract(db, clock, ops, contractId));
    expect(first.created).toBe(true);
    expect(first.delivery.status).toBe("info_gathering");
    const second = must(await createDeliveryForContract(db, clock, ops, contractId));
    expect(second.created).toBe(false);
    expect(second.delivery.id).toBe(first.delivery.id);
    expect(await db.select().from(deliveries)).toHaveLength(1);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "delivery.create"));
    expect(events).toHaveLength(1);
  });

  it("完了していない契約には作れない", async () => {
    const other = await seedDeliveryBase(db, { contractStatus: "under_review" });
    const r = await createDeliveryForContract(db, clock, other.ops, other.contract.id);
    expect(r.ok ? null : r.error).toBe("contract_not_completed");
  });
});

describe("状態遷移の正常・不正", () => {
  it("情報確認 → 制作 → 運営確認 → 顧客確認 → 公開準備 → 公開 → 納品 まで進み、各変更が履歴に残る", async () => {
    const { deliveryId, token, v1 } = await deliveryInCustomerReview();
    must(await decideAsCustomer(db, clock, token, { versionId: v1.id, decision: "approved" }));
    expect((await loadDelivery(deliveryId)).status).toBe("ready");
    const pub = must(
      await recordPublication(db, clock, ops, deliveryId, { environment: "production", url: "https://example.test/" }),
    );
    expect(pub.delivery.status).toBe("published");
    expect(pub.deployment.deliveryVersionId).toBe(v1.id);
    expect(pub.deployment.status).toBe("recorded");
    const done = must(await transitionDelivery(db, clock, ops, deliveryId, "delivered"));
    expect(done.status).toBe("delivered");

    const actions = (await db.select().from(auditEvents).where(eq(auditEvents.targetId, deliveryId))).map(
      (e) => e.action,
    );
    expect(actions).toEqual([
      "delivery.create",
      "delivery.transition",
      "delivery.version_add",
      "delivery.transition",
      "delivery.customer_review_start",
      "delivery.customer_approve",
      "delivery.publish_record",
      "delivery.transition",
    ]);
  });

  it("飛ばした遷移・専用の操作が要る遷移・戻れない遷移は拒否され、状態は変わらない", async () => {
    const { delivery } = must(await createDeliveryForContract(db, clock, ops, contractId));
    const skip = await transitionDelivery(db, clock, ops, delivery.id, "ops_review");
    expect(skip.ok ? null : skip.error).toBe("invalid_transition");
    const deliveredEarly = await transitionDelivery(db, clock, ops, delivery.id, "delivered");
    expect(deliveredEarly.ok ? null : deliveredEarly.error).toBe("invalid_transition");
    // biome-ignore lint/suspicious/noExplicitAny: 型で禁止している行き先を実行時にも拒否することの確認
    const viaGeneric = await transitionDelivery(db, clock, ops, delivery.id, "ready" as any);
    expect(viaGeneric.ok ? null : viaGeneric.error).toBe("invalid_transition");
    // 版が無いまま運営確認に回せない
    must(await transitionDelivery(db, clock, ops, delivery.id, "building"));
    const noVersion = await transitionDelivery(db, clock, ops, delivery.id, "ops_review");
    expect(noVersion.ok ? null : noVersion.error).toBe("no_version");
    // 制作中は顧客確認に回せない・公開を記録できない
    const v1 = must(await addDeliveryVersion(db, clock, ops, delivery.id, { artifactDir: "/a/v1" }));
    const early = await sendToCustomerReview(db, clock, ops, delivery.id, { versionId: v1.id });
    expect(early.ok ? null : early.error).toBe("invalid_transition");
    const pubEarly = await recordPublication(db, clock, ops, delivery.id, { environment: "production" });
    expect(pubEarly.ok ? null : pubEarly.error).toBe("invalid_transition");
    expect((await loadDelivery(delivery.id)).status).toBe("building");
    expect(await db.select().from(shareLinks)).toHaveLength(0);
  });

  it("運営確認で差し戻すと制作に戻る", async () => {
    const { deliveryId } = await deliveryInOpsReview();
    const back = must(await transitionDelivery(db, clock, ops, deliveryId, "building", "文言の誤りを直す"));
    expect(back.status).toBe("building");
  });

  it("別の納品の版は顧客確認に回せない", async () => {
    const { deliveryId } = await deliveryInOpsReview();
    const other = await seedDeliveryBase(db);
    const { delivery: d2 } = must(await createDeliveryForContract(db, clock, other.ops, other.contract.id));
    must(await transitionDelivery(db, clock, ops, d2.id, "building"));
    const foreign = must(await addDeliveryVersion(db, clock, ops, d2.id, { artifactDir: "/b/v1" }));
    const r = await sendToCustomerReview(db, clock, ops, deliveryId, { versionId: foreign.id });
    expect(r.ok ? null : r.error).toBe("version_not_found");
  });
});

describe("制作版", () => {
  it("版番号は連番で、生成ジョブIDと成果物ディレクトリを記録する。別企業の生成ジョブは紐づけない", async () => {
    const { delivery } = must(await createDeliveryForContract(db, clock, ops, contractId));
    must(await transitionDelivery(db, clock, ops, delivery.id, "building"));
    const [job] = await db
      .insert(generationJobs)
      .values({
        idempotencyKey: "delivery-test-1",
        companyId,
        purpose: "delivery_site",
        generator: "mock",
        promptVersion: "test",
      })
      .returning();
    const system: Actor = { kind: "system", job: "generation" };
    const v1 = must(
      await addDeliveryVersion(db, clock, system, delivery.id, { artifactDir: "/a/v1", generationJobId: job!.id }),
    );
    const v2 = must(await addDeliveryVersion(db, clock, ops, delivery.id, { artifactDir: "/a/v2" }));
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v1.generationJobId).toBe(job!.id);
    expect(v1.artifactDir).toBe("/a/v1");

    const other = await seedDeliveryBase(db);
    const [otherJob] = await db
      .insert(generationJobs)
      .values({
        idempotencyKey: "delivery-test-2",
        companyId: other.company.id,
        purpose: "delivery_site",
        generator: "mock",
        promptVersion: "test",
      })
      .returning();
    const foreign = await addDeliveryVersion(db, clock, ops, delivery.id, {
      artifactDir: "/a/v3",
      generationJobId: otherJob!.id,
    });
    expect(foreign.ok ? null : foreign.error).toBe("generation_job_not_found");
    const empty = await addDeliveryVersion(db, clock, ops, delivery.id, { artifactDir: "  " });
    expect(empty.ok ? null : empty.error).toBe("invalid_input");
  });
});

describe("顧客確認（AC-18）", () => {
  it("顧客はリンクで版を確認でき、承認すると版が公開対象として固定される。履歴は顧客の操作として残る", async () => {
    const { deliveryId, v1, token, linkId } = await deliveryInCustomerReview();
    const view = must(await getCustomerReview(db, clock, token));
    expect(view).toMatchObject({ versionId: v1.id, versionNumber: 1, state: "awaiting", lastDecision: null });
    expect(JSON.stringify(view)).not.toContain("/artifacts/");

    const r = must(
      await decideAsCustomer(db, clock, token, { versionId: v1.id, decision: "approved", comment: "問題ありません" }),
    );
    expect(r.delivery.status).toBe("ready");
    expect(r.delivery.lockedVersionId).toBe(v1.id);
    const [approval] = await db.select().from(approvals);
    expect(approval).toMatchObject({ deliveryVersionId: v1.id, decision: "approved", shareLinkId: linkId });
    const [event] = await db.select().from(auditEvents).where(eq(auditEvents.action, "delivery.customer_approve"));
    expect(event).toMatchObject({ actorKind: "customer", actorId: null, targetId: deliveryId });
    expect(JSON.stringify(event!.after)).not.toContain("問題ありません");

    expect(must(await getCustomerReview(db, clock, token)).state).toBe("approved");
    // 2回目の判断は受け付けない
    const again = await decideAsCustomer(db, clock, token, {
      versionId: v1.id,
      decision: "changes_requested",
      comment: "x",
    });
    expect(again.ok ? null : again.error).toBe("not_under_review");
  });

  it("承認後に再生成（版の追加）をしても、固定した版は変わらない", async () => {
    const { deliveryId, v1, token } = await deliveryInCustomerReview();
    must(await decideAsCustomer(db, clock, token, { versionId: v1.id, decision: "approved" }));
    const v2 = must(await addDeliveryVersion(db, clock, ops, deliveryId, { artifactDir: "/artifacts/delivery/v2" }));
    expect(v2.version).toBe(2);
    const d = await loadDelivery(deliveryId);
    expect(d.lockedVersionId).toBe(v1.id);
    expect(d.status).toBe("ready");
    // 公開の記録も固定した版で残る
    const pub = must(await recordPublication(db, clock, ops, deliveryId, { environment: "production" }));
    expect(pub.deployment.deliveryVersionId).toBe(v1.id);
  });

  it("修正依頼で制作に戻り、新しい版を作って顧客確認をやり直せる。前の版のリンクでは承認できない", async () => {
    const { deliveryId, v1, token } = await deliveryInCustomerReview();
    const noComment = await decideAsCustomer(db, clock, token, { versionId: v1.id, decision: "changes_requested" });
    expect(noComment.ok ? null : noComment.error).toBe("invalid_input");

    const r = must(
      await decideAsCustomer(db, clock, token, {
        versionId: v1.id,
        decision: "changes_requested",
        comment: "電話番号を代表番号に変えてください",
      }),
    );
    expect(r.delivery.status).toBe("building");
    expect(r.delivery.lockedVersionId).toBeNull();
    const view = must(await getCustomerReview(db, clock, token));
    expect(view.state).toBe("changes_requested");
    expect(view.lastDecision?.comment).toBe("電話番号を代表番号に変えてください");

    const v2 = must(await addDeliveryVersion(db, clock, ops, deliveryId, { artifactDir: "/artifacts/delivery/v2" }));
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id);
    must(await transitionDelivery(db, clock, ops, deliveryId, "ops_review"));
    const sent = must(await sendToCustomerReview(db, clock, ops, deliveryId, { versionId: v2.id }));

    // 前の回（v1）のリンクはまだ期限内だが、v1 は確認中ではないので承認できない
    const old = await decideAsCustomer(db, clock, token, { versionId: v1.id, decision: "approved" });
    expect(old.ok ? null : old.error).toBe("not_under_review");
    // v1 のリンクで v2 を承認しようとしても拒否（別の版のリンク）
    const cross = await decideAsCustomer(db, clock, token, { versionId: v2.id, decision: "approved" });
    expect(cross.ok ? null : cross.error).toBe("link_invalid");

    const ok2 = must(await decideAsCustomer(db, clock, sent.issued.token, { versionId: v2.id, decision: "approved" }));
    expect(ok2.delivery.lockedVersionId).toBe(v2.id);
    expect(await db.select().from(deliveryVersions).where(eq(deliveryVersions.deliveryId, deliveryId))).toHaveLength(2);
  });

  it("期限切れのリンクでは閲覧・承認できない。運営が同じ版でリンクを再発行すれば続けられる", async () => {
    const { deliveryId, v1, token } = await deliveryInCustomerReview();
    clock.advance(72 * HOUR);
    expect((await getCustomerReview(db, clock, token)).ok).toBe(false);
    const r = await decideAsCustomer(db, clock, token, { versionId: v1.id, decision: "approved" });
    expect(r.ok ? null : r.error).toBe("link_invalid");
    expect((await loadDelivery(deliveryId)).lockedVersionId).toBeNull();
    expect(await db.select().from(approvals)).toHaveLength(0);

    const again = must(await sendToCustomerReview(db, clock, ops, deliveryId, { versionId: v1.id }));
    const ev = await db.select().from(auditEvents).where(eq(auditEvents.action, "delivery.customer_review_reissue"));
    expect(ev).toHaveLength(1);
    must(await decideAsCustomer(db, clock, again.issued.token, { versionId: v1.id, decision: "approved" }));
  });

  it("取り消し済みのリンクでは承認できない", async () => {
    const { deliveryId, v1, token, linkId } = await deliveryInCustomerReview();
    must(await revokeShareLink(db, clock, ops, linkId));
    const r = await decideAsCustomer(db, clock, token, { versionId: v1.id, decision: "approved" });
    expect(r.ok ? null : r.error).toBe("link_invalid");
    expect((await loadDelivery(deliveryId)).status).toBe("customer_review");
  });

  it("提案用のリンクや形式違いのトークンでは承認できない", async () => {
    const { deliveryId, v1 } = await deliveryInCustomerReview();
    const bad = await decideAsCustomer(db, clock, "not-a-token", { versionId: v1.id, decision: "approved" });
    expect(bad.ok ? null : bad.error).toBe("link_invalid");
    // 同じ企業の提案リンク（用途が proposal）では、納品の承認も閲覧もできない
    const pv = await seedProposalVersion(db, companyId, { artifactDir: "/artifacts/proposal" });
    const proposalLink = must(await issueShareLink(db, clock, ops, { purpose: "proposal", targetId: pv.id }));
    const r = await decideAsCustomer(db, clock, proposalLink.token, { versionId: v1.id, decision: "approved" });
    expect(r.ok ? null : r.error).toBe("link_invalid");
    expect((await getCustomerReview(db, clock, proposalLink.token)).ok).toBe(false);
    expect((await loadDelivery(deliveryId)).status).toBe("customer_review");
  });

  it("運営が顧客確認を取り下げたら、そのリンクでは承認できない", async () => {
    const { deliveryId, v1, token } = await deliveryInCustomerReview();
    must(await transitionDelivery(db, clock, ops, deliveryId, "building"));
    expect(must(await getCustomerReview(db, clock, token)).state).toBe("closed");
    const r = await decideAsCustomer(db, clock, token, { versionId: v1.id, decision: "approved" });
    expect(r.ok ? null : r.error).toBe("not_under_review");
  });
});

describe("権限（AC-18）", () => {
  it("営業ユーザーは納品を作成・操作・閲覧できない", async () => {
    const created = await createDeliveryForContract(db, clock, sales, contractId);
    expect(created.ok ? null : created.error).toBe("forbidden");

    const { deliveryId, v1 } = await deliveryInOpsReview();
    const results = [
      await transitionDelivery(db, clock, sales, deliveryId, "building"),
      await addDeliveryVersion(db, clock, sales, deliveryId, { artifactDir: "/x" }),
      await sendToCustomerReview(db, clock, sales, deliveryId, { versionId: v1.id }),
      await recordPublication(db, clock, sales, deliveryId, { environment: "production" }),
      await getDeliveryDetail(db, sales, deliveryId),
    ];
    for (const r of results) expect(r.ok ? null : r.error).toBe("forbidden");
    expect((await loadDelivery(deliveryId)).status).toBe("ops_review");
    expect(await db.select().from(deliveryVersions)).toHaveLength(1);
    expect(await db.select().from(shareLinks)).toHaveLength(0);
  });

  it("未ログイン・顧客の操作主体は運営の操作を行えない。system は顧客確認のリンクを発行できない", async () => {
    const { deliveryId, v1 } = await deliveryInOpsReview();
    const customer: Actor = { kind: "customer", shareLinkId: "00000000-0000-0000-0000-000000000000" };
    for (const actor of [null, customer]) {
      const r = await transitionDelivery(db, clock, actor, deliveryId, "building");
      expect(r.ok ? null : r.error).toBe("forbidden");
    }
    const system: Actor = { kind: "system", job: "test" };
    const r = await sendToCustomerReview(db, clock, system, deliveryId, { versionId: v1.id });
    expect(r.ok ? null : r.error).toBe("forbidden");
  });

  it("運営は詳細（版・判断・公開記録）を読める", async () => {
    const { deliveryId, v1, token } = await deliveryInCustomerReview();
    must(await decideAsCustomer(db, clock, token, { versionId: v1.id, decision: "approved" }));
    must(await recordPublication(db, clock, ops, deliveryId, { environment: "staging" }));
    const d = must(await getDeliveryDetail(db, ops, deliveryId));
    expect(d.companyId).toBe(companyId);
    expect(d.versions.map((v) => v.version)).toEqual([1]);
    expect(d.approvals.map((a) => a.decision)).toEqual(["approved"]);
    expect(d.deployments.map((x) => x.environment)).toEqual(["staging"]);
    expect(await db.select().from(deployments)).toHaveLength(1);
  });
});
