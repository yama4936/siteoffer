import type { SkillName } from "@siteoffer/db";
import { z } from "zod";

/**
 * 運営画面・定期実行から起動するスキルの定義（起動条件の形・対象・制限時間）。
 * 制限時間・件数の上限は推奨案（アシスタントの初期値）で、仕様として確定したものではない。
 */

/** 続けて次のスキルを起動するか（探索→評価→提案→サイト作成） */
const chain = z.boolean().default(false);

export const skillParamSchemas = {
  /** 地域・業種は空なら任せる（SKILL.md の「任された場合」の選び方に従う） */
  "company-discovery": z.strictObject({
    prefecture: z.string().trim().max(10).optional(),
    city: z.string().trim().max(40).optional(),
    industry: z.string().trim().max(60).optional(),
    count: z.number().int().min(1).max(30).default(10),
    chain,
  }),
  "site-evaluation": z.strictObject({ chain }),
  "site-proposal": z.strictObject({ chain }),
  "site-rebuild": z.strictObject({}),
} satisfies Record<SkillName, z.ZodType>;

export type SkillParams<S extends SkillName> = z.infer<(typeof skillParamSchemas)[S]>;

/** 定期実行の条件。対象を取るスキルは「1回に何件起動するか」だけを持つ */
export const scheduleParamSchemas = {
  "company-discovery": skillParamSchemas["company-discovery"],
  "site-evaluation": z.strictObject({ limit: z.number().int().min(1).max(20).default(3), chain }),
  "site-proposal": z.strictObject({ limit: z.number().int().min(1).max(20).default(3), chain }),
  "site-rebuild": z.strictObject({ limit: z.number().int().min(1).max(10).default(1) }),
} satisfies Record<SkillName, z.ZodType>;

export const SKILL_LABEL: Record<SkillName, string> = {
  "company-discovery": "企業候補の探索",
  "site-evaluation": "サイトの評価",
  "site-proposal": "改善提案書",
  "site-rebuild": "改善後サイトの作成",
};

/** 何を対象に起動するか。none は条件だけで起動する */
export const SKILL_TARGET: Record<SkillName, "none" | "company" | "audit"> = {
  "company-discovery": "none",
  "site-evaluation": "company",
  "site-proposal": "audit",
  "site-rebuild": "audit",
};

/** 1回の実行の制限時間（推奨案） */
export const SKILL_TIMEOUT_MS: Record<SkillName, number> = {
  "company-discovery": 90 * 60 * 1000,
  "site-evaluation": 45 * 60 * 1000,
  "site-proposal": 30 * 60 * 1000,
  "site-rebuild": 120 * 60 * 1000,
};

/** Web検索を使うスキル。サイト作成は取得済みの材料だけで作る（SKILL.md） */
export const SKILL_WEB_SEARCH: Record<SkillName, boolean> = {
  "company-discovery": true,
  "site-evaluation": true,
  "site-proposal": false,
  "site-rebuild": false,
};

/** 作業ディレクトリへ写すスキル。探索は評価の手順も参照する */
export const SKILL_DIRS: Record<SkillName, SkillName[]> = {
  "company-discovery": ["company-discovery", "site-evaluation"],
  "site-evaluation": ["site-evaluation"],
  "site-proposal": ["site-proposal"],
  "site-rebuild": ["site-rebuild"],
};

/** 定期実行の間隔の範囲（時間） */
export const SCHEDULE_INTERVAL_HOURS = { min: 1, max: 24 * 30 } as const;

export function parseSkillParams<S extends SkillName>(skill: S, raw: unknown) {
  return skillParamSchemas[skill].safeParse(raw ?? {}) as z.ZodSafeParseResult<SkillParams<S>>;
}

/**
 * 同じ対象の未完了の実行を1件に保つキー。探索は条件ごとに別の実行として扱う。
 * 提案書とサイト作成は同じ評価ディレクトリへ書くため、評価ごとに1件にする。
 */
export function skillTargetKey(
  skill: SkillName,
  target: { companyId?: string | null; auditId?: string | null; runId: string },
) {
  switch (SKILL_TARGET[skill]) {
    case "company":
      return `${skill}:company:${target.companyId}`;
    case "audit":
      return `skill:audit:${target.auditId}`;
    default:
      return `${skill}:run:${target.runId}`;
  }
}
