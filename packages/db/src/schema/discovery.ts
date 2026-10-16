import { integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./common.ts";
import { companies } from "./companies.ts";
import { users } from "./users.ts";

export const discoveryJobStatus = pgEnum("discovery_job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "needs_review",
]);

export const discoveryJobs = pgTable("discovery_jobs", {
  id: id(),
  retryOfJobId: uuid("retry_of_job_id").unique(),
  provider: text("provider").notNull(),
  /** 都道府県・市区町村・業種・キーワード・上限など */
  criteria: jsonb("criteria").notNull(),
  status: discoveryJobStatus("status").notNull().default("queued"),
  foundCount: integer("found_count").notNull().default(0),
  createdCount: integer("created_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  /** 1回の収集で扱う候補の上限件数（8.1「件数の上限」） */
  maxResults: integer("max_results"),
  /** 候補ごとの失敗・スキップ理由。[{ externalId, stage, reason }] */
  failures: jsonb("failures").notNull().default([]),
  error: text("error"),
  createdBy: uuid("created_by").references(() => users.id),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  createdAt: createdAt(),
});

/** 候補ごとの出典。同じ取得元・外部IDは1件にする */
export const discoverySources = pgTable(
  "discovery_sources",
  {
    id: id(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => discoveryJobs.id),
    companyId: uuid("company_id").references(() => companies.id),
    provider: text("provider").notNull(),
    /** company：企業候補の出典（法人番号API等）／site：公式サイト候補の出典（検索API等） */
    role: text("role").notNull().default("company"),
    externalId: text("external_id").notNull(),
    sourceUrl: text("source_url"),
    fetchedAt: ts("fetched_at").notNull(),
    payload: jsonb("payload"),
  },
  (t) => [uniqueIndex("discovery_sources_provider_external").on(t.provider, t.externalId)],
);

export type IntakePhase = "starting" | "designs" | "images" | "discovery" | "deliveries" | "idle" | "error";
export interface WorkerCapabilities {
  version: 1;
  discoveryOnly: boolean;
  imageConfigured: boolean;
  generator: "mock" | "codex" | "unknown";
  intakeIntervalMs: number;
}
export interface WorkerProgress {
  phase: IntakePhase;
  since: string;
  completedAt: string | null;
  lastErrorAt: string | null;
}

/** Only public capabilities and liveness; never credentials or connection strings. */
export const workerRuntimes = pgTable("worker_runtimes", {
  id: uuid("id").primaryKey(),
  providers: jsonb("providers").$type<string[]>().notNull(),
  mode: text("mode").notNull(),
  heartbeatAt: ts("heartbeat_at").notNull(),
  capabilities: jsonb("capabilities").$type<WorkerCapabilities>(),
  progress: jsonb("progress").$type<WorkerProgress>(),
});
