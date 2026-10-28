// テスト専用のデータ作成。製品コードからは import しない。
// 金額・報酬条件はテスト内だけの値で、仕様の値ではない。
import type { Actor } from "@siteoffer/core";
import {
  companies,
  type Db,
  findings,
  productTerms,
  proposals,
  proposalVersions,
  siteAudits,
  users,
  websites,
} from "@siteoffer/db";

let seq = 0;

export async function seedUser(db: Db, role: "sales" | "ops") {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({ email: `ops-test-${role}${seq}@example.test`, passwordHash: "x", displayName: `${role}-${seq}`, role })
    .returning();
  const actor: Actor = role === "ops" ? { kind: "ops", userId: u!.id } : { kind: "sales", userId: u!.id };
  return { user: u!, actor };
}

/** 診断済み・提案版ありの架空企業。版の状態は引数で決める */
export async function seedCandidate(
  db: Db,
  opts: {
    versionStatus?: "in_review" | "approved" | "rejected" | null;
    pipelineStatus?: "in_review" | "generated";
  } = {},
) {
  seq += 1;
  const [company] = await db
    .insert(companies)
    .values({
      name: `架空工務店（運営テスト${seq}）`,
      prefecture: "愛知県",
      city: "名古屋市",
      officialSiteStatus: "needs_review",
      pipelineStatus: opts.pipelineStatus ?? "in_review",
    })
    .returning();
  const [site] = await db
    .insert(websites)
    .values({
      companyId: company!.id,
      url: `https://kakuu-${seq}.example.test/`,
      normalizedUrl: `kakuu-${seq}.example.test`,
      domain: `kakuu-${seq}.example.test`,
    })
    .returning();
  const [audit] = await db
    .insert(siteAudits)
    .values({
      companyId: company!.id,
      websiteId: site!.id,
      status: "evaluated",
      targetUrl: site!.url,
      totalScore: "48.5",
      coverage: "0.9",
      scoreConfirmed: true,
      criticalFlags: [{ id: "D1", reason: "問い合わせ先が見つからない" }],
      decision: "hold",
      decisionReason: "閾値が未設定",
      evaluatedAt: new Date("2026-10-10T00:00:00Z"),
    })
    .returning();
  await db.insert(findings).values({
    auditId: audit!.id,
    itemCode: "D1",
    category: "D",
    status: "scored",
    score: 0,
    reason: "電話番号・フォームが見当たらない",
    observations: [{ url: site!.url, fetched_at: "2026-10-10T00:00:00Z", evidence: "トップに連絡先なし" }],
    improvementHint: "ヘッダーに電話番号を置く",
    critical: true,
  });
  const [proposal] = await db.insert(proposals).values({ companyId: company!.id }).returning();
  let version: typeof proposalVersions.$inferSelect | null = null;
  if (opts.versionStatus !== null) {
    const [v] = await db
      .insert(proposalVersions)
      .values({ proposalId: proposal!.id, version: 1, status: opts.versionStatus ?? "in_review", auditId: audit!.id })
      .returning();
    version = v!;
  }
  return { company: company!, website: site!, audit: audit!, proposal: proposal!, version };
}

export async function seedTerms(
  db: Db,
  values: { version: string; price: number | null; rewardRule: unknown; active?: boolean; monthlyFee?: number | null },
) {
  const [t] = await db
    .insert(productTerms)
    .values({
      version: values.version,
      name: `テスト条件 ${values.version}`,
      scope: { description: "テスト用" },
      price: values.price,
      monthlyFee: values.monthlyFee ?? null,
      rewardRule: values.rewardRule,
      active: values.active ?? true,
    })
    .returning();
  return t!;
}

/** AIの事前チェック（proposal_versions.content.aiCheck）のテスト用の値 */
export function testPrecheck(status: "passed" | "failed" = "passed") {
  return {
    status,
    checkedAt: "2026-10-16T00:00:00.000Z",
    checker: { checkPy: "c".repeat(64) },
    siteDigest: `sha256:${"d".repeat(64)}`,
    items: (["company", "devices", "links", "continuity"] as const).map((key) => ({
      key,
      ok: status === "passed" || key !== "links",
      summary: `${key}の確認`,
      details: status === "failed" && key === "links" ? ["/contact へのリンクが切れています"] : [],
    })),
  };
}
