import { index, integer, jsonb, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./common.ts";
import { companies } from "./companies.ts";

export const generationPurpose = pgEnum("generation_purpose", [
  "evaluation",
  "proposal_text",
  "call_script",
  "faq",
  "demo_site",
  "delivery_site",
]);

export const generationJobStatus = pgEnum("generation_job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "needs_review",
  "cancelled",
]);

/**
 * 生成ジョブと実行記録（10.4・24.3）。
 * モデル・usage等は取得できた値だけを入れ、取れなければnullのまま（推測で埋めない）。
 */
export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: id(),
    /** 二重実行防止のキー */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    companyId: uuid("company_id").references(() => companies.id),
    purpose: generationPurpose("purpose").notNull(),
    status: generationJobStatus("status").notNull().default("queued"),
    /** 実行者が更新する生存期限。成功済み・失敗済みはnull。 */
    leaseUntil: ts("lease_until"),
    attempts: integer("attempts").notNull().default(0),
    /** codex / mock など */
    generator: text("generator").notNull(),
    requestedModel: text("requested_model"),
    responseModel: text("response_model"),
    sdkVersion: text("sdk_version"),
    cliVersion: text("cli_version"),
    promptVersion: text("prompt_version").notNull(),
    inputRef: jsonb("input_ref"),
    outputRef: jsonb("output_ref"),
    /** 検証済みの出力（文章・サイト構成のJSON）。検証に通らなかった出力は入れない */
    output: jsonb("output"),
    threadId: text("thread_id"),
    requestId: text("request_id"),
    usage: jsonb("usage"),
    /** 失敗の分類（timeout / sandbox_error / invalid_json / schema_violation / fact_violation 等） */
    errorCode: text("error_code"),
    error: text("error"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("generation_jobs_company").on(t.companyId, t.purpose),
    index("generation_jobs_lease").on(t.status, t.leaseUntil),
  ],
);
