import { ok } from "@siteoffer/core";
import { createPublicPageFetcher, type PageFetcher } from "../fetch-page.ts";
import { type AgentWebCandidate, companyCandidateSchema, siteCandidateSchema } from "../schemas.ts";
import { normalizeUrl } from "../url.ts";
import { type AgentWebVerification, type NtaLookup, verifyAgentWebCandidate } from "./agent-web-verify.ts";
import { NtaCorporateNumberProvider } from "./nta.ts";
import type { DiscoveryProvider, SearchProvider } from "./types.ts";

export const AGENT_WEB_PROVIDER = "agent-web";
export const AGENT_WEB_SITE_PROVIDER = "agent-web-site";

/** 外部ID（申告どおりの値から作る。照合の結果で変わらないようにし、再取り込みで重複させない）：法人番号、なければ公式サイトのドメイン、どちらもなければ社名と所在地 */
export function agentWebExternalId(c: AgentWebCandidate): string {
  if (c.corporate_number) return `corp:${c.corporate_number}`;
  const n = c.official_site ? normalizeUrl(c.official_site.url) : null;
  if (n?.ok) return `domain:${n.value.domain}`;
  return `name:${c.name}|${c.prefecture ?? ""}${c.city ?? ""}`;
}

const queryKey = (name: string, corporateNumber: string | null) => `${name}|${corporateNumber ?? ""}`;

export interface AgentWebOptions {
  /** 公式サイトの取得。既定は公開アドレスだけを取得する createPublicPageFetcher() */
  fetchPage?: PageFetcher;
  /** 国税庁APIの番号照会。既定は NtaCorporateNumberProvider（ID未設定なら照合を省略）。null で照会しない */
  nta?: NtaLookup | null;
  /** 同時に確認する候補の数 */
  concurrency?: number;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * company-discovery スキルが調べた候補を、収集の取得元として渡す（手動取り込み扱い。自動収集の実装ではない、8.3）。
 * 企業の取得元と、公式サイトの取得元の組。確度の判定は runDiscovery 側の judgeOfficialSite が行う。
 *
 * AIの申告はそのまま信用しない（verifyAgentWebCandidate）。
 * - 法人番号は検査用数字・国税庁API（IDがあるとき）・公式サイトの本文で確認できたものだけを使う
 * - 公式サイトの証拠は、実際に取得した本文から作る。AIが書いた evidence は判定に使わない
 * - 所在地は国税庁APIの登記所在地、または公式サイトの本文で確認できた申告の所在地だけを使う
 * - 実在を確認できない候補は exclusionReason を付けて渡し、収集側で企業を作らずに理由を残す
 */
export function createAgentWebProviders(
  list: AgentWebCandidate[],
  options: AgentWebOptions = {},
): {
  companies: DiscoveryProvider;
  search: SearchProvider;
} {
  const fetchPage = options.fetchPage ?? createPublicPageFetcher();
  const nta = options.nta === undefined ? new NtaCorporateNumberProvider() : options.nta;
  const verified = new Map<string, { c: AgentWebCandidate; v: AgentWebVerification }>();
  return {
    companies: {
      name: AGENT_WEB_PROVIDER,
      discover: async (_criteria, ctx) => {
        const results = await mapLimit(list, options.concurrency ?? 3, (c) =>
          verifyAgentWebCandidate(c, { fetchPage, nta, signal: ctx.signal }),
        );
        verified.clear();
        return ok(
          list.map((c, i) => {
            const v = results[i]!;
            if (v.status === "accepted") verified.set(queryKey(c.name, v.corporateNumber), { c, v });
            const loc = v.location;
            return companyCandidateSchema.parse({
              provider: AGENT_WEB_PROVIDER,
              externalId: agentWebExternalId(c),
              sourceUrl: c.found_via.url,
              fetchedAt: new Date(c.fetched_at),
              name: c.name,
              corporateNumber: v.corporateNumber,
              prefecture: loc?.prefecture ?? null,
              city: loc?.city ?? null,
              address: loc?.address ?? null,
              addressSourceUrl: loc?.sourceUrl ?? null,
              industry: c.industry,
              representativePhone: c.representative_phone,
              raw: {
                found_via: c.found_via,
                size_check: c.size_check ?? null,
                verification: {
                  status: v.status,
                  reasons: v.reasons,
                  declaredCorporateNumber: v.declaredCorporateNumber,
                  nta: v.nta,
                  pages: v.pages,
                },
              },
              ...(v.status === "excluded" ? { exclusionReason: `unverified: ${v.reasons.join("・")}` } : {}),
            });
          }),
        );
      },
    },
    search: {
      name: AGENT_WEB_SITE_PROVIDER,
      findOfficialSite: async (q) => {
        const hit = verified.get(queryKey(q.name, q.corporateNumber));
        if (!hit) return ok([]);
        const { c, v } = hit;
        const fetchedAt = new Date(c.fetched_at);
        const sites = [];
        if (c.official_site) {
          // 本文に社名がなければ証拠は空（judge で「ページ上で社名を確認できない」になり、verified にならない）
          const site = v.officialSite;
          sites.push(
            siteCandidateSchema.parse({
              provider: AGENT_WEB_SITE_PROVIDER,
              externalId: c.official_site.url,
              url: c.official_site.url,
              sourceUrl: site?.evidenceUrl ?? c.official_site.url,
              fetchedAt,
              evidence: site?.evidence ?? { companyName: null, address: null, corporateNumber: null },
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
