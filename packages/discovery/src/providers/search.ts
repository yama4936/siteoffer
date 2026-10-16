import { readFileSync } from "node:fs";
import { err, ok, type Result } from "@siteoffer/core";
import { type SiteCandidate, siteCandidateSchema } from "../schemas.ts";
import type { ProviderContext, SearchProvider, SearchProviderError, SiteQuery } from "./types.ts";

export interface MockSearchResult {
  url: string;
  title?: string | null;
  thirdParty?: boolean;
  evidence?: { companyName?: string | null; address?: string | null; corporateNumber?: string | null };
}

const DEFAULT_FIXTURE = new URL("../../../../fixtures/discovery/search-results.json", import.meta.url);

export function loadMockSearchResults(path: URL | string = DEFAULT_FIXTURE): Record<string, MockSearchResult[]> {
  return (
    JSON.parse(
      path === DEFAULT_FIXTURE
        ? readFileSync(DEFAULT_FIXTURE, "utf8")
        : readFileSync(/* turbopackIgnore: true */ path, "utf8"),
    ) as { results: Record<string, MockSearchResult[]> }
  ).results;
}

/**
 * 検索系APIのモック。製品が未決（24.6）のため実装はこれだけ。
 * 企業名をキーにした記録済みの結果を返す（同名企業は同じ結果を受け取る＝実際の検索と同じ曖昧さを持つ）。
 * `failFor` に入れた企業名は失敗を返す（失敗理由の記録の確認用）。
 */
export class MockSearchProvider implements SearchProvider {
  readonly name: string;
  readonly calls: SiteQuery[] = [];
  private readonly results: Record<string, MockSearchResult[]>;
  private readonly failFor: Set<string>;

  constructor(options: { results?: Record<string, MockSearchResult[]>; name?: string; failFor?: string[] } = {}) {
    this.results = options.results ?? loadMockSearchResults();
    this.name = options.name ?? "search-mock";
    this.failFor = new Set(options.failFor ?? []);
  }

  async findOfficialSite(
    query: SiteQuery,
    ctx: ProviderContext,
  ): Promise<Result<SiteCandidate[], SearchProviderError>> {
    this.calls.push(query);
    if (this.failFor.has(query.name)) return err("search_failed", `模擬的な検索失敗：${query.name}`);
    const fetchedAt = ctx.clock.now();
    const q = encodeURIComponent([query.name, query.city ?? query.prefecture ?? ""].join(" ").trim());
    return ok(
      (this.results[query.name] ?? []).map((r) =>
        siteCandidateSchema.parse({
          provider: this.name,
          externalId: r.url,
          url: r.url,
          title: r.title ?? null,
          sourceUrl: `https://search.example/?q=${q}`,
          fetchedAt,
          thirdParty: r.thirdParty ?? false,
          evidence: {
            companyName: r.evidence?.companyName ?? null,
            address: r.evidence?.address ?? null,
            corporateNumber: r.evidence?.corporateNumber ?? null,
          },
        }),
      ),
    );
  }
}
