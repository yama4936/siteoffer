import { type companies, type Db, findings, type siteAudits } from "@siteoffer/db";
import { loadCodexFixture } from "@siteoffer/generation";
import { type Fact, type GenerationInput, generationInputSchema } from "@siteoffer/schemas";
import { asc, eq } from "drizzle-orm";

export type CompanyRow = typeof companies.$inferSelect;
export type SiteAuditRow = typeof siteAudits.$inferSelect;

/** 提案の生成（改善提案文・電話台本・想定問答・デモサイト構成）に渡す入力を作る。テストでは差し替えられる */
export type GenerationInputBuilder = (
  db: Db,
  input: { company: CompanyRow; audit: SiteAuditRow },
) => Promise<GenerationInput>;

/** 改善候補として生成に渡す評価項目のレベル（0〜3のうち、これ以下） */
const WEAK_LEVEL = 1;

/**
 * 既定の入力：
 * - 事実（facts）：収集で得た企業情報。出典のある値（企業名・出典付きの所在地）だけを confirmed とし、
 *   代表電話・業種など出典の確認が取れていない値は needs_review にする（生成物に出すと検証エラー）。
 *   運営の確認（10.2）を経た事実ではないため、確認済みの扱いは「収集の出典がある」までの意味に留まる。
 * - 外部データ：診断の要約と評価項目（観測・根拠）。指示として扱わせない区画に入る。
 * - 補足（context）：診断ID・対象URL・改善候補の項目ID。
 */
export const defaultGenerationInputBuilder: GenerationInputBuilder = async (db, { company, audit }) => {
  const rows = await db.select().from(findings).where(eq(findings.auditId, audit.id)).orderBy(asc(findings.itemCode));
  const facts: Fact[] = [
    { key: "company.name", label: "会社名", value: company.name, status: "confirmed", source: null },
  ];
  if (company.address) {
    facts.push({
      key: "company.address",
      label: "所在地",
      value: company.address,
      status: company.addressSourceUrl ? "confirmed" : "needs_review",
      source: company.addressSourceUrl,
    });
  }
  if (company.representativePhone) {
    facts.push({
      key: "company.phone",
      label: "代表電話",
      value: company.representativePhone,
      status: "needs_review",
      source: null,
    });
  }
  if (company.industry) {
    facts.push({
      key: "company.industry",
      label: "業種",
      value: company.industry,
      status: "needs_review",
      source: null,
    });
  }

  const weak = rows.filter((f) => f.status === "scored" && f.score !== null && f.score <= WEAK_LEVEL);
  return {
    facts,
    externalData: [
      {
        id: "site-audit",
        sourceUrl: audit.finalUrl ?? audit.targetUrl,
        fetchedAt: audit.fetchedAt?.toISOString() ?? null,
        content: JSON.stringify(
          {
            totalScore: audit.totalScore,
            coverage: audit.coverage,
            criticalFlags: audit.criticalFlags,
            findings: rows.map((f) => ({
              item: f.itemCode,
              status: f.status,
              level: f.score,
              reason: f.reason,
              observations: f.observations,
              improvementHint: f.improvementHint,
              inference: f.inference,
              critical: f.critical,
            })),
          },
          null,
          2,
        ),
      },
    ],
    attachments: [],
    context: {
      task: "proposal",
      auditId: audit.id,
      targetUrl: audit.finalUrl ?? audit.targetUrl,
      evaluationItemIds: weak.map((f) => f.itemCode),
      notice: "非公式の提案。成約や効果を保証しない",
    },
  };
};

/**
 * デモ用の入力：fixtures/codex/input.json（架空企業「株式会社あおば工務店」の確認済みの事実）をそのまま使う。
 * モック生成器の固定応答はこの入力の事実キーを参照しているため、モックで提案・納品を最後まで通すときに使う。
 * どの企業でも同じ架空企業の内容になる。実生成（Codex）では使わない（設定で拒否する）。
 */
export const fixtureGenerationInputBuilder: GenerationInputBuilder = async () =>
  generationInputSchema.parse(loadCodexFixture("input"));
