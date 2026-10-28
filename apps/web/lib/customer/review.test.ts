import { randomUUID } from "node:crypto";
// 顧客確認の画面のサーバー処理の結合テスト（PGlite）。AC-18。
// TODO(統合)：core の index.ts に delivery を追加したら "@siteoffer/core" から読む
import {
  type Actor,
  addDeliveryVersion,
  createDeliveryForContract,
  fixedClock,
  HOUR,
  IMAGE_RIGHTS_CONSENT_ACTION,
  IMAGE_RIGHTS_CONSENT_VERSION,
  sendToCustomerReview,
  transitionDelivery,
} from "@siteoffer/core";
import { seedDeliveryBase } from "@siteoffer/core/delivery/testing";
import { approvals, auditEvents, type Db, deliveries } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatJst, INVALID_LINK_MESSAGE, loadCustomerReview, submitCustomerDecision } from "./review.ts";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-14T00:00:00Z");
let deliveryId: string;
let versionId: string;
let token: string;
let ops: Actor;

function must<T>(r: { ok: true; value: T } | { ok: false; error: string; message?: string }): T {
  if (!r.ok) throw new Error(`${r.error}: ${r.message ?? ""}`);
  return r.value;
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock.set("2026-10-14T00:00:00Z");
  const base = await seedDeliveryBase(db);
  ops = base.ops;
  const { delivery } = must(await createDeliveryForContract(db, clock, ops, base.contract.id));
  deliveryId = delivery.id;
  must(await transitionDelivery(db, clock, ops, deliveryId, "building"));
  versionId = must(await addDeliveryVersion(db, clock, ops, deliveryId, { artifactDir: "/artifacts/d/v1" })).id;
  must(await transitionDelivery(db, clock, ops, deliveryId, "ops_review"));
  token = must(await sendToCustomerReview(db, clock, ops, deliveryId, { versionId, ttlHours: 48 })).issued.token;
}, 30_000);

afterEach(async () => {
  await close();
});

const deps = () => ({ db, clock });
/** 承認に添える、写真・ロゴ等の権利への同意（画面のチェックと表示した文言の版） */
const CONSENT = { imageRightsConsent: "on", imageRightsConsentVersion: IMAGE_RIGHTS_CONSENT_VERSION };

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("requestKey", randomUUID());
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function loadDelivery() {
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  return d!;
}

describe("loadCustomerReview", () => {
  it("有効なリンクなら版とプレビュー（別オリジン）のURLを返す。成果物のパスは含めない", async () => {
    const view = await loadCustomerReview(deps(), token, "http://localhost:3200");
    expect(view).not.toBeNull();
    expect(view!.versionId).toBe(versionId);
    expect(view!.state).toBe("awaiting");
    expect(view!.previewUrl).toBe(`http://localhost:3200/s/${token}/`);
    expect(JSON.stringify(view)).not.toContain("/artifacts/");
    expect(formatJst(view!.linkExpiresAt)).toContain("2026/10/16");
  });

  it("形式違い・期限切れのリンクは null", async () => {
    expect(await loadCustomerReview(deps(), "../../etc/passwd")).toBeNull();
    clock.advance(48 * HOUR);
    expect(await loadCustomerReview(deps(), token)).toBeNull();
  });
});

describe("submitCustomerDecision", () => {
  it("承認は内容確認のチェックが必要。チェックありで承認すると版が固定される", async () => {
    const noCheck = await submitCustomerDecision(deps(), form({ token, versionId, decision: "approved" }));
    expect(noCheck?.status).toBe("error");
    expect((await loadDelivery()).lockedVersionId).toBeNull();

    const r = await submitCustomerDecision(
      deps(),
      form({ token, versionId, decision: "approved", confirmed: "on", ...CONSENT }),
    );
    expect(r?.status).toBe("ok");
    expect(r?.message).not.toMatch(/保証|必ず/);
    const d = await loadDelivery();
    expect(d.status).toBe("ready");
    expect(d.lockedVersionId).toBe(versionId);
    expect((await loadCustomerReview(deps(), token))!.state).toBe("approved");
  });

  it("承認は写真・ロゴ等の権利への同意が必要。古い文言の版では受け付けず、同意は承認と一緒に記録する", async () => {
    const base = { token, versionId, decision: "approved", confirmed: "on" };
    const noConsent = await submitCustomerDecision(deps(), form(base));
    expect(noConsent).toMatchObject({ status: "error", message: expect.stringContaining("同意") });
    const stale = await submitCustomerDecision(
      deps(),
      form({ ...base, imageRightsConsent: "on", imageRightsConsentVersion: "2020-01-01.v0" }),
    );
    expect(stale).toMatchObject({ status: "error", message: expect.stringContaining("読み直し") });
    expect(await db.select().from(approvals)).toHaveLength(0);
    expect((await loadDelivery()).lockedVersionId).toBeNull();

    expect((await submitCustomerDecision(deps(), form({ ...base, ...CONSENT })))?.status).toBe("ok");
    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, IMAGE_RIGHTS_CONSENT_ACTION));
    expect(events).toHaveLength(1);
    expect(events[0]!.after).toMatchObject({ versionId, textVersion: IMAGE_RIGHTS_CONSENT_VERSION });
  });

  it("修正依頼はコメント必須。受け付けると制作に戻り、コメントが保存される", async () => {
    const empty = await submitCustomerDecision(deps(), form({ token, versionId, decision: "changes_requested" }));
    expect(empty).toEqual({ status: "error", message: "修正してほしい点をご記入ください。" });

    const r = await submitCustomerDecision(
      deps(),
      form({ token, versionId, decision: "changes_requested", comment: "営業時間を9時からに直してください" }),
    );
    expect(r?.status).toBe("ok");
    expect((await loadDelivery()).status).toBe("building");
    const [a] = await db.select().from(approvals);
    expect(a!.comment).toBe("営業時間を9時からに直してください");
  });

  it("期限切れのリンク・別の版のID・不正な判断値は受け付けない", async () => {
    const wrongVersion = await submitCustomerDecision(
      deps(),
      form({
        token,
        versionId: "00000000-0000-4000-8000-000000000000",
        decision: "approved",
        confirmed: "on",
        ...CONSENT,
      }),
    );
    expect(wrongVersion).toEqual({ status: "error", message: INVALID_LINK_MESSAGE });

    const badDecision = await submitCustomerDecision(deps(), form({ token, versionId, decision: "publish" }));
    expect(badDecision?.status).toBe("error");

    clock.advance(48 * HOUR);
    const expired = await submitCustomerDecision(
      deps(),
      form({ token, versionId, decision: "approved", confirmed: "on", ...CONSENT }),
    );
    expect(expired).toEqual({ status: "error", message: INVALID_LINK_MESSAGE });
    expect((await loadDelivery()).status).toBe("customer_review");
    expect(await db.select().from(approvals)).toHaveLength(0);
  });

  it("受付が終わった版（承認済み）への再送は受け付けない", async () => {
    await submitCustomerDecision(deps(), form({ token, versionId, decision: "approved", confirmed: "on", ...CONSENT }));
    const again = await submitCustomerDecision(
      deps(),
      form({ token, versionId, decision: "changes_requested", comment: "やはり直したい" }),
    );
    expect(again?.status).toBe("error");
    expect((await loadDelivery()).lockedVersionId).toBe(versionId);
  });
});
