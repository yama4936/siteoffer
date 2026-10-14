import { z } from "zod";

/*
 * 生成物の出力スキーマ。Codexの構造化出力にもJSON Schemaとして渡すため、
 * 省略可能な項目は作らず、不明な値はnullにする（オブジェクトはすべてstrict）。
 */

const text = z.string().min(1);

// ---------- 改善提案（proposal_text） ----------

export const proposalMeasureSchema = z.strictObject({
  title: text,
  /** 対象箇所 */
  target: z.strictObject({
    /** 対象ページのURL。サイト全体ならnull */
    url: z.string().nullable(),
    /** ページ内の場所（ヘッダー・ファーストビュー・フッター等） */
    location: text,
  }),
  /** 現状（観測した事実） */
  current: text,
  /** 問題点（目的に対する障害） */
  problem: text,
  /** 改善内容 */
  improvement: text,
  /** 根拠の参照。評価項目ID（例：A1）や外部データID。1件以上 */
  evidenceRefs: z.array(text).min(1),
  priority: z.enum(["high", "medium", "low"]),
});

export const proposalTextSchema = z.strictObject({
  /** 3行程度の要点 */
  summary: text,
  measures: z.array(proposalMeasureSchema).min(1),
  /** 維持すべき良い点（提案時に否定しないため） */
  strengths: z.array(text),
  /** 提案の限界・未確認事項 */
  limitations: z.array(text),
});
export type ProposalText = z.infer<typeof proposalTextSchema>;

// ---------- 電話台本（call_script） ----------

export const callScriptSchema = z.strictObject({
  /** 名乗りと用件（非公式の提案であることを含める） */
  opening: text,
  sections: z
    .array(
      z.strictObject({
        title: text,
        lines: z.array(text).min(1),
      }),
    )
    .min(1),
  /** 断られた場合の対応（営業拒否の記録につなげる） */
  onDecline: text,
  closing: text,
  /** 言ってはいけないこと（未確認の実績・誇張表現など） */
  doNotSay: z.array(text),
});
export type CallScript = z.infer<typeof callScriptSchema>;

// ---------- 想定問答（faq） ----------

export const faqSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        question: text,
        answer: text,
        category: z.enum(["price", "scope", "process", "domain", "trust", "other"]),
        /** 回答が依拠する確認済み事実のキー。なければ空配列 */
        factRefs: z.array(text),
      }),
    )
    .min(1),
});
export type Faq = z.infer<typeof faqSchema>;

// ---------- サイト構成（demo_site / delivery_site。Astroテンプレートに渡すJSON） ----------

/*
 * 正はテンプレートの SiteInputSchema（templates/astro-site/schema/site-input.ts）。
 * 生成の出力はその同じ形を Codex の構造化出力向けにした SiteGenerationOutputSchema を再利用する
 * （省略可能な項目なし・不明は null・会社情報の行と実績に factRef 必須）。
 * テンプレート入力への変換は siteGenerationToSiteInput、逆は siteInputToSiteGeneration。
 * 依存の向きは schemas → astro-site（テンプレートは他パッケージに依存しない）。
 */
export { type SiteInput, type SiteInputRaw, SiteInputSchema } from "@siteoffer/astro-site/schema";
export {
  type SiteGenerationOutput as SiteConfig,
  type SiteGenerationOutput,
  SiteGenerationOutputSchema as siteConfigSchema,
  SiteGenerationOutputSchema,
  siteGenerationToSiteInput,
  siteInputToSiteGeneration,
  type ToGenerationResult,
  type ToSiteInputOptions,
} from "@siteoffer/astro-site/schema/generation";

// ---------- 評価書（evaluation。site-evaluation スキルの evaluation.json） ----------

export const EVALUATION_ITEM_IDS = [
  "A1",
  "A2",
  "A3",
  "A4",
  "B1",
  "B2",
  "B3",
  "C1",
  "C2",
  "C3",
  "C4",
  "D1",
  "D2",
  "E1",
  "E2",
  "F1",
  "F2",
  "F3",
  "F4",
  "G1",
  "G2",
  "G3",
] as const;
const evaluationItemId = z.enum(EVALUATION_ITEM_IDS);

export const CRITICAL_FLAG_IDS = [
  "CF-NO-CONTACT",
  "CF-NO-HTTPS",
  "CF-NOT-MOBILE",
  "CF-STALE",
  "CF-BROKEN",
  "CF-NOINDEX",
] as const;

const observationSchema = z.strictObject({
  fact: text,
  url: z.string().nullable(),
  evidence: text,
});

const evaluationItemSchema = z.discriminatedUnion("status", [
  z.strictObject({
    id: evaluationItemId,
    status: z.literal("scored"),
    level: z.number().int().min(0).max(3),
    observations: z.array(observationSchema).min(1),
    reason: text,
    inference: z.boolean(),
    improvement_hint: z.string().nullable(),
  }),
  z.strictObject({
    id: evaluationItemId,
    status: z.literal("not_applicable"),
    reason: text,
  }),
  z.strictObject({
    id: evaluationItemId,
    status: z.literal("unevaluable"),
    reason: text,
  }),
]);

export const evaluationSchema = z
  .strictObject({
    schema_version: z.literal("0.1"),
    rubric_version: z.literal("0.1"),
    status: z.enum(["evaluated", "unevaluable"]),
    /** status=unevaluable のときの理由。evaluated ならnull */
    fatal_reason: z.string().nullable(),
    target_url: text,
    final_url: z.string().nullable(),
    collected_at: z.string().nullable(),
    evaluated_at: z.string().nullable(),
    evaluator: z.strictObject({
      skill: z.literal("site-evaluation"),
      /** 実行記録で確認できたモデルID。なければ「不明」 */
      model: text,
    }),
    conditions: z.strictObject({
      pages: z.array(text),
      screenshot: z.boolean(),
      pagespeed: text,
    }),
    company: z.strictObject({
      name: z.string().nullable(),
      name_source: z.string().nullable(),
      location: z.string().nullable(),
      location_source: z.string().nullable(),
      industry_guess: z.string().nullable(),
    }),
    site_context: z.strictObject({
      purpose_guess: text,
      target_guess: text,
      primary_conversion_guess: text,
      basis: text,
      is_inference: z.boolean(),
    }),
    items: z.array(evaluationItemSchema),
    critical_flags: z.array(
      z.strictObject({
        id: z.enum(CRITICAL_FLAG_IDS),
        item: evaluationItemId,
        fact: text,
      }),
    ),
    sales_notes: z.strictObject({
      product_fit: text,
      proposal_ease: text,
      web_dependency_guess: text,
      existing_vendor: text,
      recent_renewal_signs: text,
      budget_decision_maker: text,
    }),
    /** score.py が書き込む。生成側は空のオブジェクトにする */
    summary: z.strictObject({}),
  })
  .superRefine((v, ctx) => {
    const ids = v.items.map((i) => i.id);
    for (const id of EVALUATION_ITEM_IDS) {
      if (!ids.includes(id)) ctx.addIssue({ code: "custom", message: `項目 ${id} がない`, path: ["items"] });
    }
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "項目IDが重複", path: ["items"] });
    if (v.status === "unevaluable") {
      if (!v.fatal_reason) ctx.addIssue({ code: "custom", message: "unevaluable なのに fatal_reason がない" });
      if (v.items.some((i) => i.status !== "unevaluable"))
        ctx.addIssue({ code: "custom", message: "取得失敗時は全項目 unevaluable にする", path: ["items"] });
    }
  });
export type Evaluation = z.infer<typeof evaluationSchema>;
