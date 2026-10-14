import type { CallScript, Faq, ProposalText, SiteGenerationOutput } from "@siteoffer/schemas";

/**
 * 提案版（proposal_versions.content）のキー名。T11で確定する（camelCase）。
 * 営業画面（apps/web/lib/sales/queries.ts）は proposalText・callScript を読む。
 */
export const PROPOSAL_CONTENT_KEYS = {
  proposalText: "proposalText",
  callScript: "callScript",
  faq: "faq",
  demoSite: "demoSite",
} as const;

export const PROPOSAL_CONTENT_SCHEMA_VERSION = 1;

/** デモの検査結果（checkDist の要約） */
export interface DemoCheckSummary {
  ok: boolean;
  pages: string[];
  counts: Record<string, number>;
  /** エラーの先頭（最大20件） */
  errors: { kind: string; file: string; detail: string }[];
  mobile: string;
}

export interface ProposalContent {
  schemaVersion: typeof PROPOSAL_CONTENT_SCHEMA_VERSION;
  /** この版を作ったステップの冪等キー（同じキーの再試行で同じ版を使う） */
  idempotencyKey: string;
  auditId: string;
  revision: string;
  [PROPOSAL_CONTENT_KEYS.proposalText]: ProposalText | null;
  [PROPOSAL_CONTENT_KEYS.callScript]: CallScript | null;
  [PROPOSAL_CONTENT_KEYS.faq]: Faq | null;
  /** デモサイトの構成（生成の出力そのもの。テンプレート入力へは siteGenerationToSiteInput で変換する） */
  [PROPOSAL_CONTENT_KEYS.demoSite]: SiteGenerationOutput | null;
  demoCheck: DemoCheckSummary | null;
  /** 用途ごとの生成ジョブID（generation_jobs.id） */
  generationJobIds: Partial<Record<"proposal_text" | "call_script" | "faq" | "demo_site", string>>;
  /** 生成器の種類（mock / codex）。モックの出力を実生成と取り違えないため */
  generator: string | null;
  /** 失敗で終わった版の理由 */
  failure: string | null;
}

export function emptyProposalContent(input: { idempotencyKey: string; auditId: string; revision: string }) {
  return {
    schemaVersion: PROPOSAL_CONTENT_SCHEMA_VERSION,
    idempotencyKey: input.idempotencyKey,
    auditId: input.auditId,
    revision: input.revision,
    proposalText: null,
    callScript: null,
    faq: null,
    demoSite: null,
    demoCheck: null,
    generationJobIds: {},
    generator: null,
    failure: null,
  } satisfies ProposalContent;
}
