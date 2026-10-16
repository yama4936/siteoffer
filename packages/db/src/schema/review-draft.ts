import { integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./common.ts";
import { proposalVersions } from "./proposal.ts";
import { users } from "./users.ts";

/** Private working copy. Null values preserve the revision after discard or review. */
export const proposalReviewDrafts = pgTable(
  "proposal_review_drafts",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    proposalVersionId: uuid("proposal_version_id")
      .notNull()
      .references(() => proposalVersions.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    values: jsonb("values").$type<Record<string, string | boolean>>(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("proposal_review_draft_owner_version").on(t.userId, t.proposalVersionId)],
);

/** Idempotency receipt, without a second copy of the private note. */
export const proposalReviewSubmissions = pgTable("proposal_review_submissions", {
  requestKey: text("request_key").primaryKey(),
  proposalVersionId: uuid("proposal_version_id")
    .notNull()
    .references(() => proposalVersions.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});
