import type { Clock, Result } from "@siteoffer/core";
import type { CompanyCandidate, DiscoveryCriteria, DiscoveryCriteriaInput, SiteCandidate } from "../schemas.ts";

export type DiscoveryProviderError =
  | "invalid_criteria"
  | "nta_application_id_missing"
  | "nta_prefecture_required"
  | "nta_unknown_prefecture"
  | "nta_bad_request"
  | "nta_rate_limited"
  | "nta_invalid_application_id"
  | "nta_server_error"
  | "nta_unexpected_response"
  | "network_error";

export interface ProviderContext {
  clock: Clock;
}

/**
 * 企業候補の取得元（8.3：差し替え可能にする）。
 * 収集条件は Zod で検証してから使う。候補には出典URL・取得日時・外部IDを付ける。
 */
export interface DiscoveryProvider {
  readonly name: string;
  discover(
    criteria: DiscoveryCriteriaInput | DiscoveryCriteria,
    ctx: ProviderContext,
  ): Promise<Result<CompanyCandidate[], DiscoveryProviderError>>;
}

export type SearchProviderError = "search_unavailable" | "search_rate_limited" | "search_failed";

/** 公式サイト候補を探すための企業情報 */
export interface SiteQuery {
  name: string;
  corporateNumber: string | null;
  prefecture: string | null;
  city: string | null;
  address: string | null;
}

/**
 * 検索系APIで公式サイト候補を探す（24.6）。製品は未決のため、実装はモックのみ。
 * 返す候補は確度を判定する前の生の結果で、第三者サイトや同名企業のサイトを含みうる。
 */
export interface SearchProvider {
  readonly name: string;
  findOfficialSite(query: SiteQuery, ctx: ProviderContext): Promise<Result<SiteCandidate[], SearchProviderError>>;
}
