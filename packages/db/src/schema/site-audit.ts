import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./common.ts";
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
    rubricVersion: text("rubric_version"),
    totalScore: numeric("total_score"),
    coverage: numeric("coverage"),
    decision: proposalDecision("decision"),
    decisionReason: text("decision_reason"),
    unevaluableReason: text("unevaluable_reason"),
    /** 評価書・収集結果の保存先（Gitに入れない領域） */
    artifactDir: text("artifact_dir"),
    generationJobId: uuid("generation_job_id").references(() => generationJobs.id),
    attempts: integer("attempts").notNull().default(0),
    fetchedAt: ts("fetched_at"),
    evaluatedAt: ts("evaluated_at"),
    createdAt: createdAt(),
  },
  (t) => [index("site_audits_company").on(t.companyId)],
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
    score: integer("score"),
    reason: text("reason"),
    observations: jsonb("observations").notNull(),
    improvementHint: text("improvement_hint"),
    inference: boolean("inference").notNull().default(false),
    critical: boolean("critical").notNull().default(false),
  },
  (t) => [index("findings_audit").on(t.auditId)],
);
