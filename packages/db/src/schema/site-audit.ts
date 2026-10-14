import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./common.ts";
import { companies, websites } from "./companies.ts";
import { generationJobs } from "./generation.ts";

export const siteAuditStatus = pgEnum("site_audit_status", [
  "queued",
  "collecting",
  "scoring",
  "evaluated",
  "unevaluable",
  "failed",
]);

/** 提案書の作成判定（site-proposal の decide.py）。閾値未設定の間は hold */
export const proposalDecision = pgEnum("proposal_decision", ["create", "skip", "hold"]);

export const siteAudits = pgTable(
  "site_audits",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    websiteId: uuid("website_id")
      .notNull()
      .references(() => websites.id),
    status: siteAuditStatus("status").notNull().default("queued"),
    /** 診断を依頼したURL（AC-05：取得結果の対象を示す） */
    targetUrl: text("target_url").notNull(),
    /** リダイレクト後の最終URL（collect.py の site.final_url） */
    finalUrl: text("final_url"),
    rubricVersion: text("rubric_version"),
    /** score.py の総合点。カバー率不足・評価不能ではnull（低評価で埋めない） */
    totalScore: numeric("total_score"),
    coverage: numeric("coverage"),
    /** score.py の score_confirmed（カバー率が最小値以上で総合点が確定したか） */
    scoreConfirmed: boolean("score_confirmed"),
    /** 致命項目（score.py が書き戻した critical_flags） */
    criticalFlags: jsonb("critical_flags"),
    /** score.py の summary 全体（カテゴリ点・評価不能項目など） */
    summary: jsonb("summary"),
    decision: proposalDecision("decision"),
    decisionReason: text("decision_reason"),
    unevaluableReason: text("unevaluable_reason"),
    /** status=failed の理由（スクリプトの異常終了・検証エラー・生成失敗など。再試行の対象） */
    failureReason: text("failure_reason"),
    /** 採点に使ったモデル。実行記録で確認できなければnull（推測で埋めない） */
    evaluatorModel: text("evaluator_model"),
    /** 評価書・収集結果の保存先（Gitに入れない領域） */
    artifactDir: text("artifact_dir"),
    generationJobId: uuid("generation_job_id").references(() => generationJobs.id),
    attempts: integer("attempts").notNull().default(0),
    fetchedAt: ts("fetched_at"),
    evaluatedAt: ts("evaluated_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("site_audits_company").on(t.companyId), index("site_audits_website").on(t.websiteId, t.createdAt)],
);

export const findingStatus = pgEnum("finding_status", ["scored", "unevaluable", "not_applicable"]);

/** 評価項目ごとの結果（A1〜G3）。根拠と推測かどうかを持つ（9章） */
export const findings = pgTable(
  "findings",
  {
    id: id(),
    auditId: uuid("audit_id")
      .notNull()
      .references(() => siteAudits.id),
    itemCode: text("item_code").notNull(),
    category: text("category").notNull(),
    status: findingStatus("status").notNull(),
    /** レベル0〜3（scored のときだけ）。配点への換算は score.py の summary を正とする */
    score: integer("score"),
    reason: text("reason"),
    observations: jsonb("observations").notNull(),
    improvementHint: text("improvement_hint"),
    inference: boolean("inference").notNull().default(false),
    critical: boolean("critical").notNull().default(false),
  },
  (t) => [index("findings_audit").on(t.auditId), uniqueIndex("findings_audit_item").on(t.auditId, t.itemCode)],
);
