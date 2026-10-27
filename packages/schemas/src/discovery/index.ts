import { z } from "zod";

/**
 * 収集条件（8.1）。運営が設定し、discovery_jobs.criteria に保存する。
 * 業種分類は未決（8.1）のため、業種は自由記述の文字列で受け取る。
 */
export const discoveryCriteriaSchema = z
  .object({
    /** 都道府県名（例：愛知県）。全国へ広げられるよう任意にする */
    prefecture: z.string().trim().min(1).max(10).optional(),
    /** 市区町村名（例：名古屋市、名古屋市中区）。前方一致で照合する */
    city: z.string().trim().min(1).max(40).optional(),
    /** 市区町村コード（JIS X 0402、都道府県コード2桁＋3桁）。国税庁APIの所在地指定に使う */
    cityCode: z
      .string()
      .regex(/^\d{5}$/)
      .optional(),
    industry: z.string().trim().min(1).max(60).optional(),
    /** 企業名に含まれる語。所在地の判定には使わない（8.1） */
    keywords: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
    /** 1回の収集で扱う候補の上限件数 */
    limit: z.number().int().min(1).max(1000).default(50),
  })
  .refine((c) => !c.city || c.prefecture, { message: "市区町村を指定する場合は都道府県も指定する", path: ["city"] });

export type DiscoveryCriteria = z.output<typeof discoveryCriteriaSchema>;
export type DiscoveryCriteriaInput = z.input<typeof discoveryCriteriaSchema>;

/** 公式サイトの確度（companies.official_site_status と同じ値） */
export const officialSiteStatusSchema = z.enum(["confirmed", "candidate", "needs_review", "not_found"]);
export type OfficialSiteStatusValue = z.infer<typeof officialSiteStatusSchema>;

/** 取得元が返す企業候補。出典URL・取得日時・外部IDを必ず持つ */
export const companyCandidateSchema = z.object({
  provider: z.string().min(1),
  externalId: z.string().min(1),
  sourceUrl: z.string().url(),
  fetchedAt: z.date(),
  name: z.string().trim().min(1),
  corporateNumber: z
    .string()
    .regex(/^\d{13}$/)
    .nullable()
    .default(null),
  /** 所在地は出典のあるものだけを入れる。不明なら null */
  prefecture: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  address: z.string().nullable().default(null),
  addressSourceUrl: z.string().url().nullable().default(null),
  industry: z.string().nullable().default(null),
  representativePhone: z.string().nullable().default(null),
  /** 取得元の応答（保存用）。秘密値を入れない */
  raw: z.unknown().optional(),
});
export type CompanyCandidate = z.output<typeof companyCandidateSchema>;
export type CompanyCandidateInput = z.input<typeof companyCandidateSchema>;

/**
 * 検索系APIが返す公式サイト候補。
 * evidence はページ上で確認できた情報（社名・所在地・法人番号）。確認できなければ空。
 */
export const siteCandidateSchema = z.object({
  provider: z.string().min(1),
  externalId: z.string().min(1),
  url: z.string().url(),
  title: z.string().nullable().default(null),
  sourceUrl: z.string().url(),
  fetchedAt: z.date(),
  /** 取得元が第三者サイト（ポータル・SNS・求人等）と示している場合 true */
  thirdParty: z.boolean().default(false),
  evidence: z
    .object({
      companyName: z.string().nullable().default(null),
      address: z.string().nullable().default(null),
      corporateNumber: z.string().nullable().default(null),
    })
    .default({ companyName: null, address: null, corporateNumber: null }),
});
export type SiteCandidate = z.output<typeof siteCandidateSchema>;
export type SiteCandidateInput = z.input<typeof siteCandidateSchema>;

/** ジョブに記録する失敗理由 */
export const discoveryFailureSchema = z.object({
  externalId: z.string().nullable(),
  stage: z.enum(["provider", "candidate", "search", "save"]),
  reason: z.string(),
});
export type DiscoveryFailure = z.infer<typeof discoveryFailureSchema>;

/**
 * company-discovery スキル（エージェントのWeb調査）が書く候補ファイル（candidates.json）の1社分。
 * 項目名はスキルの成果物に合わせてスネークケース。evidence はページ上に書かれていたものだけ（推測で埋めない）。
 */
export const agentWebCandidateSchema = z.object({
  name: z.string().trim().min(1),
  corporate_number: z
    .string()
    .regex(/^\d{13}$/)
    .nullable()
    .default(null),
  prefecture: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  address: z.string().nullable().default(null),
  address_source_url: z.string().url().nullable().default(null),
  industry: z.string().nullable().default(null),
  representative_phone: z.string().nullable().default(null),
  /** 企業を見つけたページ（名簿・検索結果・公式サイト等） */
  found_via: z.object({ url: z.string().url(), note: z.string().optional() }),
  fetched_at: z.string().datetime({ offset: true }),
  official_site: z
    .object({
      url: z.string().url(),
      /** 社名・所在地を確認したページ（会社概要等） */
      evidence_url: z.string().url(),
      evidence: z.object({
        company_name: z.string().nullable().default(null),
        address: z.string().nullable().default(null),
        corporate_number: z.string().nullable().default(null),
      }),
    })
    .nullable(),
  other_sites: z.array(z.object({ url: z.string().url(), third_party: z.boolean().default(true) })).default([]),
  /** 除外条件（上場・大企業・FC・支店）の確認結果と出典 */
  size_check: z.unknown().optional(),
});
export type AgentWebCandidate = z.output<typeof agentWebCandidateSchema>;

export const agentWebFileSchema = z.object({
  criteria: z.unknown(),
  candidates: z.array(agentWebCandidateSchema).max(1000),
  excluded: z.array(z.unknown()).default([]),
});
export type AgentWebFile = z.output<typeof agentWebFileSchema>;
