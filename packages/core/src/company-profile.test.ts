import { randomUUID } from "node:crypto";
import {
  auditEvents,
  companies,
  type Db,
  deliveryVersions,
  generationJobs,
  proposalVersions,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { EMPTY_COMPANY_PROFILE } from "@siteoffer/schemas";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fixedClock } from "./common/clock.ts";
import {
  assertCompanyProfileCurrent,
  generationCompanyProfileCurrent,
  loadCompanyProfileForOps,
  saveCompanyProfile,
} from "./company-profile.ts";
import { issueShareLink, verifyShareLink } from "./share-link/share-link.ts";
import { seedAssignment, seedDeliveryVersion, seedProposalVersion, seedUser } from "./share-link/test-helpers.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-18T00:00:00Z");
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock.set("2026-10-18T00:00:00Z");
});
afterEach(async () => close());
async function seed() {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test`, displayName: "架空の運営", passwordHash: "fixture", role: "ops" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "架空の連絡先確認会社", representativePhone: "052-000-1111" })
    .returning();
  const actor = { kind: "ops" as const, userId: user!.id };
  const input = {
    companyId: company!.id,
    expectedRevision: 0,
    values: { ...EMPTY_COMPANY_PROFILE, email: "contact@example.test", services: "架空の制作検証" },
    source: "架空の公式サイトで確認",
    confirmed: true,
  };
  return { actor, company: company!, input };
}
it("運営の実在・有効状態をサーバーで検査し、無権限では読み書きしない", async () => {
  const s = await seed();
  for (const actor of [
    null,
    { kind: "sales" as const, userId: s.actor.userId },
    { kind: "system" as const, job: "test" },
  ]) {
    await expect(saveCompanyProfile(db, clock, actor, s.input)).rejects.toThrow("運営");
    await expect(loadCompanyProfileForOps(db, actor, s.company.id)).rejects.toThrow("運営");
  }
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, s.actor.userId));
  await expect(saveCompanyProfile(db, clock, s.actor, s.input)).rejects.toThrow("運営");
});
it("確認情報と根拠・担当者を保存し、候補の元の情報は書き換えず、同じ保存で版を増やさない", async () => {
  const s = await seed(),
    first = await saveCompanyProfile(db, clock, s.actor, {
      ...s.input,
      values: { ...s.input.values, email: " contact@example.test " },
    });
  expect(first.profile).toMatchObject({ revision: 1, confirmedBy: s.actor.userId, source: s.input.source });
  expect(await loadCompanyProfileForOps(db, s.actor, s.company.id)).toMatchObject({
    confirmedByName: "架空の運営",
    values: { email: "contact@example.test" },
  });
  clock.set("2026-10-18T00:01:00Z");
  const repeated = await saveCompanyProfile(db, clock, s.actor, { ...s.input, expectedRevision: 1 });
  expect(repeated.unchanged).toBe(true);
  expect(repeated.profile.confirmedAt).toEqual(first.profile.confirmedAt);
  expect((await db.select().from(companies))[0]!.representativePhone).toBe("052-000-1111");
  const events = await db.select().from(auditEvents);
  expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain("contact@example.test");
});
it("同じ版からの同時保存は片方だけ成功し、古い画面では上書きできない", async () => {
  const s = await seed();
  const results = await Promise.allSettled([
    saveCompanyProfile(db, clock, s.actor, s.input),
    saveCompanyProfile(db, clock, s.actor, { ...s.input, source: "別の架空確認根拠" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
});
it("確認なし・不正な連絡先・短い根拠・未知項目では保存しない", async () => {
  const s = await seed();
  for (const change of [
    { confirmed: false },
    { source: "" },
    { values: { ...s.input.values, email: "not-email" } },
    { values: { ...s.input.values, phone: "110" } },
    { values: { ...s.input.values, script: "unsafe" } },
  ])
    await expect(saveCompanyProfile(db, clock, s.actor, { ...s.input, ...change })).rejects.toThrow("入力");
  expect(await loadCompanyProfileForOps(db, s.actor, s.company.id)).toBeNull();
});
it("新しい生成の参照版を照合し、取り下げ・変更後の成果物は有効にしない", async () => {
  const s = await seed();
  await saveCompanyProfile(db, clock, s.actor, s.input);
  const [job] = await db
    .insert(generationJobs)
    .values({
      idempotencyKey: randomUUID(),
      companyId: s.company.id,
      purpose: "demo_site",
      status: "succeeded",
      generator: "mock",
      promptVersion: "fixture",
      inputRef: { companyProfileRevision: 1 },
    })
    .returning();
  expect(await generationCompanyProfileCurrent(db, s.company.id, job!.id)).toBe(true);
  await db.transaction((tx) => assertCompanyProfileCurrent(tx, s.company.id, 1));
  await saveCompanyProfile(db, clock, s.actor, {
    ...s.input,
    expectedRevision: 1,
    values: EMPTY_COMPANY_PROFILE,
    source: "利用を取り下げる架空確認",
  });
  expect(await generationCompanyProfileCurrent(db, s.company.id, job!.id)).toBe(false);
  await expect(db.transaction((tx) => assertCompanyProfileCurrent(tx, s.company.id, 1))).rejects.toThrow("変更");
  expect(await generationCompanyProfileCurrent(db, randomUUID(), job!.id)).toBe(false);
});
it.each(["proposal", "delivery"] as const)(
  "%sの共有は確認情報の変更で停止し、同じ保存では維持する",
  async (purpose) => {
    const s = await seed();
    await saveCompanyProfile(db, clock, s.actor, s.input);
    const [job] = await db
      .insert(generationJobs)
      .values({
        idempotencyKey: randomUUID(),
        companyId: s.company.id,
        purpose: purpose === "proposal" ? "demo_site" : "delivery_site",
        status: "succeeded",
        generator: "mock",
        promptVersion: "fixture",
        inputRef: { companyProfileRevision: 1 },
      })
      .returning();
    const sales = await seedUser(db, "sales"),
      assignment = await seedAssignment(db, s.company.id, sales.user.id);
    let id: string;
    if (purpose === "proposal") {
      const version = await seedProposalVersion(db, s.company.id, { artifactDir: "/fictional-artifacts/demo" });
      id = version.id;
      await db.update(proposalVersions).set({ generationJobId: job!.id }).where(eq(proposalVersions.id, id));
    } else {
      const version = await seedDeliveryVersion(
        db,
        s.company.id,
        assignment.id,
        sales.user.id,
        "/fictional-artifacts/delivery",
      );
      id = version.id;
      await db.update(deliveryVersions).set({ generationJobId: job!.id }).where(eq(deliveryVersions.id, id));
    }
    const issued = await issueShareLink(db, clock, s.actor, { purpose, targetId: id });
    if (!issued.ok) throw Error(issued.error);
    expect((await verifyShareLink(db, clock, issued.value.token)).ok).toBe(true);
    await saveCompanyProfile(db, clock, s.actor, { ...s.input, expectedRevision: 1 });
    expect((await verifyShareLink(db, clock, issued.value.token)).ok).toBe(true);
    await saveCompanyProfile(db, clock, s.actor, {
      ...s.input,
      expectedRevision: 1,
      values: { ...s.input.values, email: "updated@example.test" },
    });
    expect((await verifyShareLink(db, clock, issued.value.token)).ok).toBe(false);
    expect((await issueShareLink(db, clock, s.actor, { purpose, targetId: id })).ok).toBe(false);
  },
);
