import { ok } from "@siteoffer/core";
import { type AgentWebCandidate, companyCandidateSchema, siteCandidateSchema } from "../schemas.ts";
import { normalizeUrl } from "../url.ts";
import type { DiscoveryProvider, SearchProvider } from "./types.ts";

export const AGENT_WEB_PROVIDER = "agent-web";
export const AGENT_WEB_SITE_PROVIDER = "agent-web-site";

/** 外部ID：法人番号、なければ公式サイトのドメイン、どちらもなければ社名と所在地 */
export function agentWebExternalId(c: AgentWebCandidate): string {
  if (c.corporate_number) return `corp:${c.corporate_number}`;
  const n = c.official_site ? normalizeUrl(c.official_site.url) : null;
  if (n?.ok) return `domain:${n.value.domain}`;
  return `name:${c.name}|${c.prefecture ?? ""}${c.city ?? ""}`;
}

const queryKey = (name: string, corporateNumber: string | null) => `${name}|${corporateNumber ?? ""}`;

/**
 * company-discovery スキルが調べた候補を、収集の取得元として渡す（手動取り込み扱い。自動収集の実装ではない、8.3）。
 * 企業の取得元と、公式サイトの取得元（ページ上の証拠を返すだけ）の組。確度の判定は runDiscovery 側の judgeOfficialSite が行う。
 * 所在地は出典URLがあるものだけを渡す。
 */
export function createAgentWebProviders(list: AgentWebCandidate[]): {
  companies: DiscoveryProvider;
  search: SearchProvider;
} {
  const byQuery = new Map(list.map((c) => [queryKey(c.name, c.corporate_number), c]));
  return {
    companies: {
      name: AGENT_WEB_PROVIDER,
      discover: async () =>
        ok(
          list.map((c) => {
            const sourced = !!c.address_source_url;
            return companyCandidateSchema.parse({
              provider: AGENT_WEB_PROVIDER,
              externalId: agentWebExternalId(c),
              sourceUrl: c.found_via.url,
              fetchedAt: new Date(c.fetched_at),
              name: c.name,
              corporateNumber: c.corporate_number,
              prefecture: sourced ? c.prefecture : null,
              city: sourced ? c.city : null,
              address: sourced ? c.address : null,
              addressSourceUrl: c.address_source_url,
              industry: c.industry,
              representativePhone: c.representative_phone,
              raw: { found_via: c.found_via, size_check: c.size_check ?? null },
            });
          }),
        ),
    },
    search: {
      name: AGENT_WEB_SITE_PROVIDER,
      findOfficialSite: async (q) => {
        const c = byQuery.get(queryKey(q.name, q.corporateNumber));
        if (!c) return ok([]);
        const fetchedAt = new Date(c.fetched_at);
        const sites = [];
        if (c.official_site) {
          const ev = c.official_site.evidence;
          sites.push(
            siteCandidateSchema.parse({
              provider: AGENT_WEB_SITE_PROVIDER,
              externalId: c.official_site.url,
              url: c.official_site.url,
              sourceUrl: c.official_site.evidence_url,
              fetchedAt,
              evidence: { companyName: ev.company_name, address: ev.address, corporateNumber: ev.corporate_number },
            }),
          );
        }
        for (const s of c.other_sites) {
          sites.push(
            siteCandidateSchema.parse({
              provider: AGENT_WEB_SITE_PROVIDER,
              externalId: s.url,
              url: s.url,
              sourceUrl: s.url,
              fetchedAt,
              thirdParty: s.third_party,
            }),
          );
        }
        return ok(sites);
      },
    },
  };
}
