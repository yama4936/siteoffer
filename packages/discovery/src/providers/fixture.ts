import { readFileSync } from "node:fs";
import { err, ok, type Result } from "@siteoffer/core";
import {
  type CompanyCandidate,
  companyCandidateSchema,
  type DiscoveryCriteria,
  discoveryCriteriaSchema,
} from "../schemas.ts";
import type { DiscoveryProvider, DiscoveryProviderError, ProviderContext } from "./types.ts";

export interface FixtureCompany {
  externalId: string;
  name: string;
  corporateNumber: string | null;
  prefecture: string | null;
  city: string | null;
  address: string | null;
  industry: string | null;
  representativePhone: string | null;
  sourceUrl: string;
}

const DEFAULT_FIXTURE = new URL("../../../../fixtures/discovery/companies.json", import.meta.url);

export function loadFixtureCompanies(path: URL | string = DEFAULT_FIXTURE): FixtureCompany[] {
  const json = JSON.parse(readFileSync(path, "utf8")) as { companies: FixtureCompany[] };
  return json.companies;
}

/**
 * 架空企業で動く取得元（8.3）。
 * キーワードがあるときは「企業名で検索する取得元」を模擬し、所在地では絞らない
 * （名前に「名古屋」を含む別県企業も返る。所在地の判定は収集の実行側が出典付きの所在地で行う）。
 * キーワードがないときは都道府県・市区町村（前方一致）で絞る。所在地不明の企業は地域検索では返さない。
 */
export class FixtureProvider implements DiscoveryProvider {
  readonly name: string;
  private readonly companies: FixtureCompany[];

  constructor(options: { companies?: FixtureCompany[]; name?: string } = {}) {
    this.companies = options.companies ?? loadFixtureCompanies();
    this.name = options.name ?? "fixture";
  }

  async discover(input: unknown, ctx: ProviderContext): Promise<Result<CompanyCandidate[], DiscoveryProviderError>> {
    const parsed = discoveryCriteriaSchema.safeParse(input);
    if (!parsed.success) return err("invalid_criteria", parsed.error.message);
    const criteria: DiscoveryCriteria = parsed.data;
    const fetchedAt = ctx.clock.now();

    const matches = this.companies.filter((c) => {
      if (criteria.industry && !(c.industry ?? "").includes(criteria.industry)) return false;
      if (criteria.keywords.length > 0) return criteria.keywords.some((k) => c.name.includes(k));
      if (criteria.prefecture && c.prefecture !== criteria.prefecture) return false;
      if (criteria.city && !(c.city ?? "").startsWith(criteria.city)) return false;
      return true;
    });

    return ok(
      matches.slice(0, criteria.limit).map((c) =>
        companyCandidateSchema.parse({
          provider: this.name,
          externalId: c.externalId,
          sourceUrl: c.sourceUrl,
          fetchedAt,
          name: c.name,
          corporateNumber: c.corporateNumber,
          prefecture: c.prefecture,
          city: c.city,
          address: c.address,
          addressSourceUrl: c.address || c.city ? c.sourceUrl : null,
          industry: c.industry,
          representativePhone: c.representativePhone,
          raw: c,
        }),
      ),
    );
  }
}
