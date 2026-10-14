import { z } from "zod";

/** 生成の用途。DBの generation_purpose と一致させる */
export const generationPurposes = [
  "evaluation",
  "proposal_text",
  "call_script",
  "faq",
  "demo_site",
  "delivery_site",
] as const;
export const generationPurposeSchema = z.enum(generationPurposes);
export type GenerationPurpose = z.infer<typeof generationPurposeSchema>;

/**
 * 生成に渡す事実（10.2）。
 * confirmed：運営・顧客が確認した値。生成物で事実として使ってよい。
 * needs_review：未確認。生成物に出してはいけない（出たら検証エラー）。
 */
export const factStatusSchema = z.enum(["confirmed", "needs_review"]);
export type FactStatus = z.infer<typeof factStatusSchema>;

export const factSchema = z.strictObject({
  /** 出力側から参照するキー（例：company.name、achievement.1） */
  key: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_.-]+$/),
  label: z.string().min(1),
  value: z.string().min(1),
  status: factStatusSchema,
  /** 出典（URL・確認者・資料名など）。不明ならnull */
  source: z.string().nullable(),
});
export type Fact = z.infer<typeof factSchema>;

/**
 * 外部データ（取得したサイト本文・collect.py の観測など）。
 * 指示として扱わない。プロンプトでは専用の区画に入れる（19章・24.4）。
 */
export const externalDataSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_.-]+$/),
  sourceUrl: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  content: z.string(),
});
export type ExternalData = z.infer<typeof externalDataSchema>;

/** 作業ディレクトリに置く添付（スクリーンショット等） */
export const attachmentSchema = z.strictObject({
  /** 作業ディレクトリ内のファイル名 */
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_.-]+$/),
  /** アプリ側のローカルパス（コンテナには作業ディレクトリへのコピーだけが渡る） */
  path: z.string().min(1),
  kind: z.enum(["image", "text", "file"]),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const generationInputSchema = z.strictObject({
  facts: z.array(factSchema),
  externalData: z.array(externalDataSchema),
  attachments: z.array(attachmentSchema),
  /** 用途ごとの補足（商品範囲・目的・評価結果の参照IDなど）。プロンプトにJSONで入る */
  context: z.record(z.string(), z.unknown()),
});
export type GenerationInput = z.infer<typeof generationInputSchema>;

/*
 * 要確認の表記はテンプレートの要確認マーカー `{{要確認:説明}}` に統一する（正は templates/astro-site/lib/markers.ts）。
 * 生成物にはマーカーを入れさせない（不明な値は null）。マーカーの検出には markerRegex を使う。
 */
export { formatMarker, MARKER_LABEL, markerRegex } from "@siteoffer/astro-site/markers";

/**
 * マーカーの形になっていない仮置きの語。生成物に残っていたら、マーカーと同じく検証エラーにする
 * （先頭はマーカーの見出し語。`{{` `}}` を付け忘れた「要確認」も拾う）。
 */
export const NEEDS_REVIEW_MARKERS = ["要確認", "仮置き", "TODO", "TBD"] as const;
