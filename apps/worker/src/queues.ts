import { z } from "zod";

/**
 * キューの定義（18章「収集」「提案」と、定期ジョブ）。
 * 上限値（タイムアウト・試行回数・再試行の間隔）は推奨案（アシスタントの初期値）で、仕様として確定したものではない。
 */
export const QUEUES = {
  /** 収集ジョブ（discovery_jobs の1件）を実行し、公式サイト確認済みの企業を診断へ送る */
  discovery: "pipeline.discovery",
  /** 企業の公式サイトを診断し、判定が create なら生成へ送る */
  audit: "pipeline.audit",
  /** 改善提案文・電話台本・想定問答・デモサイト構成を生成し、デモをビルド・検査して運営確認待ちで保存する */
  proposal: "pipeline.proposal",
  /** 定期：担当の期限解除（12.2） */
  expireAssignments: "maintenance.expire-assignments",
  /** 定期：実行中のまま残った収集ジョブを失敗に戻す */
  recoverDiscovery: "maintenance.recover-stale-discovery",
  /** 定期：稼働通知が途切れた生成ジョブの履歴を閉じる */
  recoverGeneration: "maintenance.recover-stale-generation",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const discoveryPayloadSchema = z.strictObject({
  discoveryJobId: z.uuid(),
});
export type DiscoveryPayload = z.infer<typeof discoveryPayloadSchema>;

export const auditPayloadSchema = z.strictObject({
  companyId: z.uuid(),
  /**
   * 同じ企業の診断を区別するキー。同じ値の二重投入は1回しか実行しない。
   * 収集から送るときは収集ジョブID、再診断は新しい値（運営の操作ID等）にする。
   */
  requestKey: z.string().min(1).max(200),
});
export type AuditPayload = z.infer<typeof auditPayloadSchema>;

export const proposalPayloadSchema = z.strictObject({
  companyId: z.uuid(),
  auditId: z.uuid(),
  designVersionId: z.uuid().optional(),
  /** 再生成の識別。省略時は初回（initial）。再生成は新しい値で送り、新しい版として保存する */
  revision: z.string().min(1).max(200).default("initial"),
});
export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;
export type ProposalPayloadInput = z.input<typeof proposalPayloadSchema>;

export const emptyPayloadSchema = z.object({}).passthrough();

/** 冪等キー。同じ企業・同じ入力なら同じキーになる */
export const stepKeys = {
  discovery: (p: DiscoveryPayload) => `discovery:${p.discoveryJobId}`,
  audit: (p: AuditPayload) => `audit:${p.companyId}:${p.requestKey}`,
  proposal: (p: ProposalPayload) =>
    `proposal:${p.companyId}:${p.auditId}:${p.revision}${p.designVersionId ? `:${p.designVersionId}` : ""}`,
};

export interface StepPolicy {
  /** 1回の試行の制限時間 */
  timeoutMs: number;
  /** 最大試行回数（初回を含む） */
  maxAttempts: number;
  /** 再試行までの待ち（pg-boss の retryDelay。指数的に伸ばす） */
  retryDelaySeconds: number;
}

export type StepKind = "discovery" | "audit" | "proposal";

export const DEFAULT_POLICIES: Record<StepKind, StepPolicy> = {
  discovery: { timeoutMs: 30 * 60 * 1000, maxAttempts: 3, retryDelaySeconds: 60 },
  // collect.py（10分）＋採点の生成（15分×試行）を収める
  audit: { timeoutMs: 60 * 60 * 1000, maxAttempts: 3, retryDelaySeconds: 120 },
  // 生成4件（各15分×試行）＋Astroのビルド（2分）を収める
  proposal: { timeoutMs: 120 * 60 * 1000, maxAttempts: 3, retryDelaySeconds: 300 },
};

/** 定期ジョブの既定の実行間隔（cron。推奨案） */
export const DEFAULT_SCHEDULES = {
  expireAssignments: "*/10 * * * *",
  recoverDiscovery: "*/15 * * * *",
  recoverGeneration: "* * * * *",
} as const;
