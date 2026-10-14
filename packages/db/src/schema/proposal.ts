import { index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./common.ts";
import { companies } from "./companies.ts";
import { generationJobs } from "./generation.ts";
import { siteAudits } from "./site-audit.ts";
import { users } from "./users.ts";

export const proposals = pgTable("proposals", {
  id: id(),
  companyId: uuid("company_id")
    .notNull()
    .unique()
    .references(() => companies.id),
  createdAt: createdAt(),
});

export const proposalVersionStatus = pgEnum("proposal_version_status", [
  "generating",
  "in_review",
  "approved",
  "rejected",
  "failed",
]);

/** 再生成は新しい版として保存する（10.3）。契約で選んだ版は契約側のスナップショットで固定する */
export const proposalVersions = pgTable(
  "proposal_versions",
  {
    id: id(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id),
    version: integer("version").notNull(),
    status: proposalVersionStatus("status").notNull().default("generating"),
    auditId: uuid("audit_id").references(() => siteAudits.id),
    /** 改善提案・電話台本・想定問答など（Zodで検証済みの構造） */
    content: jsonb("content"),
    demoArtifactDir: text("demo_artifact_dir"),
    generationJobId: uuid("generation_job_id").references(() => generationJobs.id),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    reviewNote: text("review_note"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("proposal_versions_proposal_version").on(t.proposalId, t.version),
    index("proposal_versions_status").on(t.status),
  ],
);
