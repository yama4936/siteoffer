import { isValidCorporateNumber } from "@siteoffer/schemas";
import type { PageFetcher } from "../fetch-page.ts";
import { coreName, isThirdPartyDomain } from "../judge.ts";
import {
  findAddressOnPage,
  findCorporateNumbers,
  htmlToText,
  textMentionsAddress,
  textMentionsCompanyName,
} from "../page-facts.ts";
import type { AgentWebCandidate } from "../schemas.ts";
import { normalizeUrl } from "../url.ts";
import type { NtaCorporateNumberProvider } from "./nta.ts";

/**
 * agent-web（AIエージェントの調査）の候補の実在確認。
 * AIの申告（法人番号・URL・evidence）をそのまま信用せず、次の照合を通ったものだけを採用する。
 * 1. 法人番号の検査用数字
 * 2. 国税庁APIでの番号照会（アプリケーションIDがあるときだけ。ないときは省略したことを理由に残す）
 * 3. 申告された公式サイトを実際に取得し、本文の社名・法人番号・所在地を照合する
 * 実在を確認できない（公式サイトの本文に社名がなく、国税庁APIでも確認できない）候補と、
 * 登記記録が閉鎖された候補は除外する（人の確認待ちには回さない）。
 */

export type NtaLookup = Pick<NtaCorporateNumberProvider, "hasApplicationId" | "lookupNumber">;

export type NtaCheck =
  | "not_requested"
  | "skipped_no_application_id"
  | "matched"
  | "not_found"
  | "closed"
  | "name_mismatch"
  | "error";

export interface PageCheck {
  url: string;
  finalUrl: string | null;
  /** 取得できなかった理由。取得できたら null */
  error: string | null;
  nameFound: boolean;
  corporateNumbers: string[];
}

export interface VerifiedLocation {
  prefecture: string | null;
  city: string | null;
  address: string | null;
  sourceUrl: string;
}

export interface AgentWebVerification {
  status: "accepted" | "excluded";
  /** 判定の経過（運営が確認できるよう、取り込み元の記録に残す） */
  reasons: string[];
  declaredCorporateNumber: string | null;
  /** 照合を通った法人番号。通らなければ null */
  corporateNumber: string | null;
  nta: NtaCheck;
  location: VerifiedLocation | null;
  pages: PageCheck[];
  /** 公式サイトの本文から得た証拠。本文に社名がなければ null（AIの evidence は使わない） */
  officialSite: {
    url: string;
    evidenceUrl: string;
    evidence: { companyName: string | null; address: string | null; corporateNumber: string | null };
  } | null;
}

interface FetchedText {
  url: string;
  text: string;
}

function sameSite(a: string, b: string): boolean {
  const x = normalizeUrl(a);
  const y = normalizeUrl(b);
  return x.ok && y.ok && x.value.domain === y.value.domain;
}

async function fetchOfficialPages(
  c: AgentWebCandidate,
  fetchPage: PageFetcher,
  reasons: string[],
  signal?: AbortSignal,
): Promise<{ pages: PageCheck[]; texts: FetchedText[] }> {
  const site = c.official_site;
  const pages: PageCheck[] = [];
  const texts: FetchedText[] = [];
  if (!site) {
    reasons.push("公式サイトの申告なし");
    return { pages, texts };
  }
  const n = normalizeUrl(site.url);
  if (!n.ok) {
    reasons.push(`公式サイトのURLを扱えない（${n.error}）`);
    return { pages, texts };
  }
  if (isThirdPartyDomain(n.value.domain)) {
    reasons.push("申告された公式サイトが第三者サイトのドメイン");
    return { pages, texts };
  }
  const urls = [site.url];
  if (site.evidence_url !== site.url) {
    if (sameSite(site.evidence_url, site.url)) urls.push(site.evidence_url);
    else reasons.push("evidence_url が公式サイトと別のドメインのため取得しない");
  }
  for (const url of urls) {
    const r = await fetchPage(url, { signal });
    if (!r.ok) {
      pages.push({ url, finalUrl: null, error: r.error, nameFound: false, corporateNumbers: [] });
      reasons.push(`公式サイトを取得できない（${r.error}）`);
      continue;
    }
    if (!sameSite(r.value.finalUrl, site.url)) {
      pages.push({
        url,
        finalUrl: r.value.finalUrl,
        error: "redirected_off_site",
        nameFound: false,
        corporateNumbers: [],
      });
      reasons.push("公式サイトが別のドメインへ転送された");
      continue;
    }
    const text = htmlToText(r.value.body);
    const nameFound = textMentionsCompanyName(text, c.name);
    pages.push({
      url,
      finalUrl: r.value.finalUrl,
      error: null,
      nameFound,
      corporateNumbers: findCorporateNumbers(text),
    });
    texts.push({ url: r.value.finalUrl, text });
  }
  return { pages, texts };
}

export async function verifyAgentWebCandidate(
  c: AgentWebCandidate,
  deps: { fetchPage: PageFetcher; nta: NtaLookup | null; signal?: AbortSignal },
): Promise<AgentWebVerification> {
  const reasons: string[] = [];
  let excludedBy: string | null = null;

  // 1. 法人番号の検査用数字
  let number: string | null = null;
  let registryConfirmed = false;
  let location: VerifiedLocation | null = null;
  let nta: NtaCheck = "not_requested";
  if (c.corporate_number) {
    if (isValidCorporateNumber(c.corporate_number)) number = c.corporate_number;
    else reasons.push("法人番号の検査用数字が合わないため、申告の番号を使わない");
  }

  // 2. 国税庁APIでの照会（IDがあるときだけ）
  if (number) {
    if (!deps.nta?.hasApplicationId()) {
      nta = "skipped_no_application_id";
      reasons.push("国税庁APIでの照合は省略（アプリケーションID未設定）");
    } else {
      const r = await deps.nta.lookupNumber(number);
      if (!r.ok) {
        nta = "error";
        reasons.push(`国税庁APIでの照会に失敗（${r.error}）`);
      } else if (!r.value.corporation) {
        nta = "not_found";
        reasons.push("国税庁APIに該当する法人番号がないため、申告の番号を使わない");
        number = null;
      } else {
        const corp = r.value.corporation;
        const nameMatches = coreName(corp.name) === coreName(c.name);
        if (corp.closeDate) {
          nta = "closed";
          number = null;
          if (nameMatches) excludedBy = `登記記録が閉鎖されている（閉鎖日 ${corp.closeDate}）`;
          else reasons.push("国税庁APIの法人は閉鎖済みかつ社名が異なるため、申告の番号を使わない");
        } else if (!nameMatches) {
          nta = "name_mismatch";
          number = null;
          reasons.push("国税庁APIの商号が申告の社名と一致しないため、申告の番号を使わない");
        } else {
          nta = "matched";
          registryConfirmed = true;
          reasons.push("国税庁APIで法人番号・商号を確認（閉鎖なし）");
          if (corp.prefectureName) {
            location = {
              prefecture: corp.prefectureName,
              city: corp.cityName || null,
              address: corp.streetNumber || null,
              sourceUrl: r.value.sourceUrl,
            };
          }
        }
      }
    }
  }

  // 3. 公式サイトの実取得と照合
  const { pages, texts } = await fetchOfficialPages(c, deps.fetchPage, reasons, deps.signal);
  const named = texts.filter((t) => textMentionsCompanyName(t.text, c.name));
  const siteConfirmed = named.length > 0;
  if (texts.length > 0 && !siteConfirmed) reasons.push("公式サイトの本文に社名がない");
  const pageNumbers = [...new Set(pages.flatMap((p) => (p.nameFound ? p.corporateNumbers : [])))];

  // 国税庁APIで確認できなかった番号は、公式サイトの本文（社名のあるページ）に書かれている場合だけ採用する
  if (number && !registryConfirmed) {
    if (pageNumbers.includes(number)) reasons.push("法人番号を公式サイトの本文で確認");
    else {
      reasons.push("法人番号を国税庁APIでも公式サイトの本文でも確認できないため、申告の番号を使わない");
      number = null;
    }
  }

  // 所在地：国税庁APIの登記所在地、なければ申告の所在地のうち公式サイトの本文で確認できたもの
  if (!location && siteConfirmed && c.city) {
    for (const t of named) {
      if (findAddressOnPage(t.text, c.prefecture, c.city)) {
        location = {
          prefecture: c.prefecture,
          city: c.city,
          address: textMentionsAddress(t.text, c.address) ? c.address : null,
          sourceUrl: t.url,
        };
        break;
      }
    }
    if (!location) reasons.push("申告の所在地を公式サイトの本文で確認できない");
  }

  let officialSite: AgentWebVerification["officialSite"] = null;
  if (siteConfirmed && c.official_site) {
    const evidencePage = named.find((t) => location && findAddressOnPage(t.text, location.prefecture, location.city));
    const page = evidencePage ?? named[0]!;
    const onPage = pageNumbers.includes(number ?? "") ? number : number ? (pageNumbers[0] ?? null) : null;
    officialSite = {
      url: c.official_site.url,
      evidenceUrl: page.url,
      evidence: {
        companyName: c.name,
        address: location ? findAddressOnPage(page.text, location.prefecture, location.city) : null,
        corporateNumber: onPage,
      },
    };
  }

  if (!excludedBy && !siteConfirmed && !registryConfirmed) {
    excludedBy = "実在を確認できない（公式サイトの本文に社名がなく、国税庁APIでも確認できない）";
  }
  if (excludedBy) reasons.push(excludedBy);
  return {
    status: excludedBy ? "excluded" : "accepted",
    reasons,
    declaredCorporateNumber: c.corporate_number,
    corporateNumber: excludedBy ? null : number,
    nta,
    location: excludedBy ? null : location,
    pages,
    officialSite: excludedBy ? null : officialSite,
  };
}
