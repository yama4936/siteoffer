import { z } from "zod";

/**
 * 最終確認の前にAIが行う事前チェック（proposal_versions.content.aiCheck）。
 * worker が書き込み、運営の最終確認画面が読む。passed の版だけを人が承認できる。
 * - company：会社情報
 * - devices：PC・スマホの表示
 * - links：リンク・導線
 * - continuity：既存機能の引き継ぎ
 */
export const PROPOSAL_PRECHECK_KEYS = ["company", "devices", "links", "continuity"] as const;
export type ProposalPrecheckKey = (typeof PROPOSAL_PRECHECK_KEYS)[number];

export const proposalPrecheckItemSchema = z
  .object({
    key: z.enum(PROPOSAL_PRECHECK_KEYS),
    ok: z.boolean(),
    summary: z.string().max(2000),
    details: z.array(z.string().max(4000)).max(100),
  })
  .strict();

export const proposalPrecheckSchema = z
  .object({
    status: z.enum(["passed", "failed"]),
    checkedAt: z.iso.datetime({ offset: true }),
    checker: z.object({ checkPy: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    siteDigest: z.string().min(1).max(200),
    items: z
      .array(proposalPrecheckItemSchema)
      .length(PROPOSAL_PRECHECK_KEYS.length)
      .refine((items) => PROPOSAL_PRECHECK_KEYS.every((key) => items.filter((i) => i.key === key).length === 1), {
        message: "4項目を1回ずつ含めてください",
      }),
  })
  .strict()
  .refine((v) => v.status === "failed" || v.items.every((i) => i.ok), {
    message: "passed の場合はすべての項目が ok である必要があります",
  });

export type ProposalPrecheck = z.infer<typeof proposalPrecheckSchema>;
export type ProposalPrecheckItem = z.infer<typeof proposalPrecheckItemSchema>;

/** 不正な値・未実施なら null を返す */
export function parseProposalPrecheck(value: unknown): ProposalPrecheck | null {
  const parsed = proposalPrecheckSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
