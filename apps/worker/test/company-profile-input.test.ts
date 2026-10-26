import { randomUUID } from "node:crypto";
import { fixedClock, saveCompanyProfile } from "@siteoffer/core";
import { companies, type Db, siteAudits, users, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { EMPTY_COMPANY_PROFILE } from "@siteoffer/schemas";
import { afterEach, beforeEach, expect, it } from "vitest";
import { defaultGenerationInputBuilder, siteGenerationInputIssue } from "../src/input.ts";

let db: Db, close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => close());
it("収集した電話を勝手に確認済みにせず、運営が確認した情報を提案・納品の入力へ渡す", async () => {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.test`, displayName: "架空運営", passwordHash: "fixture", role: "ops" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "架空入力の会社", representativePhone: "052-000-1111", industry: "未確認業種" })
    .returning();
  const [website] = await db
    .insert(websites)
    .values({
      companyId: company!.id,
      url: "https://fixture.example.test",
      normalizedUrl: "https://fixture.example.test",
      domain: "fixture.example.test",
    })
    .returning();
  const [audit] = await db
    .insert(siteAudits)
    .values({ companyId: company!.id, websiteId: website!.id, targetUrl: website!.url })
    .returning();
  const args = { company: company!, audit: audit! };
  const initial = await defaultGenerationInputBuilder(db, args);
  expect(initial.facts.find((f) => f.key === "company.phone")?.status).toBe("needs_review");
  expect(siteGenerationInputIssue(initial)).toContain("会社情報");
  const actor = { kind: "ops" as const, userId: user!.id },
    clock = fixedClock("2026-10-18T00:00:00Z");
  await saveCompanyProfile(db, clock, actor, {
    companyId: company!.id,
    expectedRevision: 0,
    values: { ...EMPTY_COMPANY_PROFILE, email: "contact@example.test", services: "架空の確認済みサービス" },
    source: "架空の確認根拠",
    confirmed: true,
  });
  const verified = await defaultGenerationInputBuilder(db, args);
  expect(siteGenerationInputIssue(verified)).toBeNull();
  expect(verified.context.companyProfileRevision).toBe(1);
  expect(verified.facts.find((f) => f.key === "company.email")).toMatchObject({
    value: "contact@example.test",
    status: "confirmed",
    source: "架空の確認根拠",
  });
  expect(verified.facts.some((f) => f.key === "company.phone")).toBe(false);
  await saveCompanyProfile(db, clock, actor, {
    companyId: company!.id,
    expectedRevision: 1,
    values: EMPTY_COMPANY_PROFILE,
    source: "架空の取り下げ理由",
    confirmed: true,
  });
  const withdrawn = await defaultGenerationInputBuilder(db, args);
  expect(withdrawn.context.companyProfileRevision).toBe(2);
  expect(siteGenerationInputIssue(withdrawn)).not.toBeNull();
  expect(withdrawn.facts.some((f) => f.key === "company.phone")).toBe(false);
});
