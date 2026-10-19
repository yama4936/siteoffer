// Isolated DB fixtures only. Never import into a product page or insert into the normal demo.
import { randomUUID } from "node:crypto";
import { companies, type Db, findings, siteAudits, websites } from "@siteoffer/db";
import { seedUser } from "./test-seed";

export async function seedAuditHistoryFixture(db: Db) {
  const { actor: ops } = await seedUser(db, "ops"),
    { actor: sales } = await seedUser(db, "sales");
  const [company, other] = await db
    .insert(companies)
    .values([{ name: "診断履歴の架空試験企業" }, { name: "対象外の架空企業" }])
    .returning();
  const target = "https://audit-history.example.test/";
  const [site, otherSite] = await db
    .insert(websites)
    .values([
      {
        companyId: company!.id,
        url: target,
        normalizedUrl: "audit-history.example.test",
        domain: "audit-history.example.test",
      },
      {
        companyId: other!.id,
        url: target,
        normalizedUrl: "other-audit-history.example.test",
        domain: "other-audit-history.example.test",
      },
    ])
    .returning();
  const statuses = ["queued", "collecting", "scoring", "evaluated", "unevaluable", "failed"] as const;
  const rows = Array.from({ length: 240 }, (_, index) => ({
    id: randomUUID(),
    companyId: company!.id,
    websiteId: site!.id,
    targetUrl: target,
    status: statuses[index % 6]!,
    rubricVersion: "fixture-1",
    evaluatorModel: "fixture-model",
    totalScore: index % 6 === 3 ? (index === 237 ? "50.2" : "50.1") : null,
    coverage: "0.9",
    scoreConfirmed: index % 6 === 3,
    artifactDir: "private-path-never-render",
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, Math.floor(index / 3))),
  }));
  const records = await db.insert(siteAudits).values(rows).returning();
  const selected = records[237]!,
    previous = records[231]!;
  await db.insert(findings).values([
    {
      auditId: previous.id,
      itemCode: "A1",
      category: "A",
      status: "scored",
      score: 1,
      reason: "前回の理由",
      observations: [],
      improvementHint: "前回の案",
    },
    {
      auditId: selected.id,
      itemCode: "A1",
      category: "A",
      status: "scored",
      score: 3,
      reason: "今回の理由",
      observations: [{ url: target, evidence: "試験専用の根拠" }],
      improvementHint: "今回の案",
    },
    {
      auditId: previous.id,
      itemCode: "D1",
      category: "D",
      status: "scored",
      score: 0,
      reason: "前回",
      observations: [],
      critical: true,
    },
    {
      auditId: selected.id,
      itemCode: "D1",
      category: "D",
      status: "unevaluable",
      reason: "取得できず",
      observations: [],
      inference: true,
    },
  ]);
  const [otherAudit] = await db
    .insert(siteAudits)
    .values({
      companyId: other!.id,
      websiteId: otherSite!.id,
      targetUrl: target,
      status: "evaluated",
      createdAt: new Date("2027-01-01T00:00:00Z"),
    })
    .returning();
  return {
    ops,
    sales,
    company: company!,
    other: other!,
    site: site!,
    otherSite: otherSite!,
    records,
    selected,
    previous,
    otherAudit: otherAudit!,
  };
}
