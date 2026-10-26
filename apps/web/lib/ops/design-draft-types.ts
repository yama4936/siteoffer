import type { DesignBrief } from "@siteoffer/core";

export type DesignDraftScope = { companyId: string; designId: string | null; auditId: string | null };
export type DesignDraftSnapshot = { revision: number; values: DesignBrief | null; updatedAt: string | null };
export type DesignDraftResult =
  | { status: "ok"; snapshot: DesignDraftSnapshot }
  | { status: "conflict"; snapshot: DesignDraftSnapshot }
  | { status: "error"; message: string };
export type DesignCreateResult = { status: "ok"; url: string } | Exclude<DesignDraftResult, { status: "ok" }>;
export const DESIGN_BRIEF_FIELDS: [keyof DesignBrief, string][] = [
  ["objective", "サイトで実現したいこと"],
  ["audience", "想定するお客様"],
  ["direction", "デザインの方向性"],
  ["scope", "制作範囲・確認事項"],
  ["updatePlan", "更新機能・既存データの引き継ぎ"],
];
