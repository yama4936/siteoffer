import { createHash, randomUUID } from "node:crypto";
import { createDeliveryForContract, fixedClock, loadDeliverySource } from "@siteoffer/core";
import {
  assignments,
  companies,
  contracts,
  type Db,
  deliveries,
  deliveryBuilds,
  designVersions,
  domainPreferences,
  imageAssets,
  proposalVersions,
  siteAudits,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { transitionDeliveryByOps } from "./delivery";
import { getDeliveryPreparation } from "./delivery-preparation";
import { seedCandidate, seedUser } from "./test-seed";

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
  const f = await seedCandidate(db, { versionStatus: "approved" });
  const ops = (await seedUser(db, "ops")).actor,
    sales = (await seedUser(db, "sales")).actor;
  const [a] = await db
    .insert(assignments)
    .values({ companyId: f.company.id, userId: sales.userId, status: "completed", claimedAt: clock.now() })
    .returning();
  const image = Buffer.from("fixture-design");
  const [design] = await db
    .insert(designVersions)
    .values({
      companyId: f.company.id,
      auditId: f.audit.id,
      version: 1,
      requestKey: randomUUID(),
      status: "approved",
      brief: { scope: "2ページ", updatePlan: "既存のお知らせ10件を確認して移行" },
      companySnapshot: {},
      prompt: "private-prompt",
      source: "import",
      imageBase64: image.toString("base64"),
      imageSha256: createHash("sha256").update(image).digest("hex"),
    })
    .returning();
  await db
    .update(proposalVersions)
    .set({ content: { designVersionId: design!.id } })
    .where(eq(proposalVersions.id, f.version!.id));
  const [contract] = await db
    .insert(contracts)
    .values({
      companyId: f.company.id,
      assignmentId: a!.id,
      salesUserId: sales.userId,
      status: "completed",
      proposalVersionId: f.version!.id,
      reportedAt: clock.now(),
      snapshot: {
        version: 1,
        terms: { name: "固定商品", price: 220000, monthlyFee: 1000, scope: { description: "契約した2ページ" } },
        reward: { amount: 55555 },
        documentRef: "private.pdf",
      },
    })
    .returning();
  const delivery = must(await createDeliveryForContract(db, clock, ops, contract!.id)).delivery;
  return { ...f, ops, sales, contract: contract!, delivery, design: design!, assignment: a! };
}
it("契約時の範囲と提案デザインを選び、後の最新提案へ差し替えない", async () => {
  const s = await setup();
  await db
    .insert(proposalVersions)
    .values({ proposalId: s.proposal.id, version: 2, status: "approved", content: { designVersionId: randomUUID() } });
  const d = must(await getDeliveryPreparation(db, s.ops, s.delivery.id));
  expect(d.proposal?.id).toBe(s.version!.id);
  expect(d.design?.id).toBe(s.design.id);
  expect(d.scope?.scope).toEqual({ description: "契約した2ページ" });
  expect(d.blockers).toEqual([]);
  expect(JSON.stringify(d)).not.toContain("private.pdf");
  expect(JSON.stringify(d)).not.toContain("private-prompt");
  expect(JSON.stringify(d)).not.toContain(s.design.imageBase64!);
  expect(JSON.stringify(d)).not.toContain("55555");
});
it("他社の提案と診断を契約へ誤って指定しても読み込まない", async () => {
  const s = await setup(),
    other = await seedCandidate(db, { versionStatus: "approved" });
  await db.update(contracts).set({ proposalVersionId: other.version!.id }).where(eq(contracts.id, s.contract.id));
  const source = await loadDeliverySource(db, s.contract.id);
  expect(source!.proposal).toBeNull();
  expect(source!.blockers.join()).toContain("提案版");
  await db.update(contracts).set({ proposalVersionId: s.version!.id }).where(eq(contracts.id, s.contract.id));
  await db.update(proposalVersions).set({ auditId: other.audit.id }).where(eq(proposalVersions.id, s.version!.id));
  const invalid = await loadDeliverySource(db, s.contract.id);
  expect(invalid!.audit).toBeNull();
  expect(invalid!.blockers.join()).toContain("診断");
});
it.each(["foreign", "rejected", "corrupt", "invalid_id"])(
  "デザイン参照の不整合(%s)を制作開始前に拒否する",
  async (kind) => {
    const s = await setup();
    if (kind === "foreign") {
      const [c] = await db.insert(companies).values({ name: "他社" }).returning();
      await db.update(designVersions).set({ companyId: c!.id }).where(eq(designVersions.id, s.design.id));
    }
    if (kind === "rejected")
      await db.update(designVersions).set({ status: "rejected" }).where(eq(designVersions.id, s.design.id));
    if (kind === "corrupt")
      await db
        .update(designVersions)
        .set({ imageBase64: Buffer.from("changed").toString("base64") })
        .where(eq(designVersions.id, s.design.id));
    if (kind === "invalid_id")
      await db
        .update(proposalVersions)
        .set({ content: { designVersionId: "not-uuid" } })
        .where(eq(proposalVersions.id, s.version!.id));
    expect(
      await transitionDeliveryByOps({ db, clock }, s.ops, { deliveryId: s.delivery.id, to: "building" }),
    ).toMatchObject({ ok: false, error: "preparation_required" });
    expect((await db.select().from(deliveries))[0]!.status).toBe("info_gathering");
    expect(await db.select().from(deliveryBuilds)).toHaveLength(0);
  },
);
it("未完了契約・未評価診断では開始しない", async () => {
  const s = await setup();
  await db.update(contracts).set({ status: "reported" }).where(eq(contracts.id, s.contract.id));
  await db.update(siteAudits).set({ status: "failed" }).where(eq(siteAudits.id, s.audit.id));
  const d = must(await getDeliveryPreparation(db, s.ops, s.delivery.id));
  expect(d.blockers.join()).toContain("契約確認");
  expect(d.blockers.join()).toContain("診断");
});
it("本番の許諾確認と現在のドメイン希望をまとめ、無許可素材を確認済みにしない", async () => {
  const s = await setup();
  await db.insert(imageAssets).values([
    { companyId: s.company.id, label: "未確認", sourceType: "original_site" },
    {
      companyId: s.company.id,
      label: "デモのみ",
      sourceType: "customer_upload",
      rightsStatus: "use_approved",
      allowSalesDemo: true,
      confirmedBy: s.ops.userId,
      confirmedAt: clock.now(),
    },
    {
      companyId: s.company.id,
      label: "本番",
      sourceType: "customer_upload",
      rightsStatus: "use_approved",
      allowProduction: true,
      confirmedBy: s.ops.userId,
      confirmedAt: clock.now(),
    },
  ]);
  await db.insert(domainPreferences).values({
    companyId: s.company.id,
    assignmentId: s.assignment.id,
    recordedBy: s.sales.userId,
    intent: "keep",
    currentDomain: "example.test",
    needsOpsReview: true,
  });
  const d = must(await getDeliveryPreparation(db, s.ops, s.delivery.id));
  expect(d.assets).toEqual({ total: 3, production: 1, ready: 0, currentBuildCount: 0, currentBuildAllowed: true });
  expect(d.domain).toMatchObject({ intent: "keep", confirmed: false });
  expect(d.design?.updatePlan).toContain("10件");
});
it("営業・停止運営・不正IDは制作準備を取得できない", async () => {
  const s = await setup();
  expect(await getDeliveryPreparation(db, s.sales, s.delivery.id)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await getDeliveryPreparation(db, s.ops, "bad")).toMatchObject({ ok: false, error: "not_found" });
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.ops.userId));
  expect(await getDeliveryPreparation(db, s.ops, s.delivery.id)).toMatchObject({ ok: false, error: "forbidden" });
});
it("提案未紐付けの旧契約は不足を明示して制作を止める", async () => {
  const s = await setup();
  await db.update(contracts).set({ proposalVersionId: null, snapshot: null }).where(eq(contracts.id, s.contract.id));
  const d = must(await getDeliveryPreparation(db, s.ops, s.delivery.id));
  expect(d.audit?.id).toBe(s.audit.id);
  expect(d.scope).toBeNull();
  expect(d.blockers).toHaveLength(3);
  expect(d.supplementation.needed).toBe(true);
});
