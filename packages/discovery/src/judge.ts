import type { OfficialSiteStatusValue, SiteCandidate } from "./schemas.ts";
import { normalizeUrl } from "./url.ts";

/**
 * 第三者サイト（ポータル・SNS・求人・地図・口コミ等）のドメイン。公式サイトとして扱わない。
 * 末尾一致で判定する。運営設定で増やせるよう、判定関数には追加分を渡せる。
 */
export const DEFAULT_THIRD_PARTY_DOMAINS = [
  // 架空のフィクスチャ用
  "portal-directory.example",
  "directory.example",
  "jobs.example",
  "sns.example",
  "search.example",
  // 一般的な第三者サイト（企業情報ではなく、ドメインの分類のための一覧）
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "tiktok.com",
  "line.me",
  "linkedin.com",
  "note.com",
  "ameblo.jp",
  "google.com",
  "goo.ne.jp",
  "yahoo.co.jp",
  "wikipedia.org",
  "indeed.com",
  "en-japan.com",
  "rikunabi.com",
  "mynavi.jp",
  "doda.jp",
  "baseconnect.in",
  "ekiten.jp",
  "tabelog.com",
  "hotpepper.jp",
  "itp.ne.jp",
];

export type SiteVerdict = "verified" | "probable" | "third_party" | "other_company" | "unrelated";

export interface JudgedSite {
  candidate: SiteCandidate;
  normalizedUrl: string | null;
  domain: string | null;
  verdict: SiteVerdict;
  reason: string;
}

export interface CompanyFacts {
  name: string;
  corporateNumber: string | null;
  prefecture: string | null;
  city: string | null;
  address: string | null;
}

export interface OfficialSiteJudgement {
  status: OfficialSiteStatusValue;
  /** 企業のサイトとして保存してよいもの（confirmed なら verified、candidate なら probable） */
  sites: JudgedSite[];
  judged: JudgedSite[];
  reason: string;
}

const LEGAL_FORMS = [
  "株式会社",
  "有限会社",
  "合同会社",
  "合資会社",
  "合名会社",
  "一般社団法人",
  "一般財団法人",
  "公益社団法人",
  "公益財団法人",
  "特定非営利活動法人",
  "医療法人社団",
  "医療法人",
  "社会福祉法人",
  "（株）",
  "(株)",
  "（有）",
  "(有)",
];

function norm(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/** 法人格・空白を除いた社名の芯 */
export function coreName(name: string): string {
  let n = norm(name);
  for (const f of LEGAL_FORMS) n = n.split(norm(f)).join("");
  return n;
}

const PREFECTURE_RE = /^(北海道|東京都|京都府|大阪府|.{2,3}県)/;

/**
 * ページ上の所在地が企業の所在地と一致するか。
 * 一致：市区町村（と、書かれていれば都道府県）が一致する。食い違い：所在地が書かれているが一致しない。
 * 企業側の所在地が不明なら判定しない（unknown）。
 */
export function compareAddress(company: CompanyFacts, pageAddress: string | null): "match" | "mismatch" | "unknown" {
  if (!pageAddress || !company.city) return "unknown";
  const page = norm(pageAddress);
  const pref = page.match(PREFECTURE_RE)?.[1];
  if (pref && company.prefecture && pref !== norm(company.prefecture)) return "mismatch";
  const rest = pref ? page.slice(pref.length) : page;
  return rest.startsWith(norm(company.city)) ? "match" : "mismatch";
}

export function isThirdPartyDomain(domain: string, extra: readonly string[] = []): boolean {
  return [...DEFAULT_THIRD_PARTY_DOMAINS, ...extra].some((d) => domain === d || domain.endsWith(`.${d}`));
}

function judgeOne(company: CompanyFacts, c: SiteCandidate, extraThirdParty: readonly string[]): JudgedSite {
  const n = normalizeUrl(c.url);
  const base = {
    candidate: c,
    normalizedUrl: n.ok ? n.value.normalizedUrl : null,
    domain: n.ok ? n.value.domain : null,
  };
  if (!n.ok) return { ...base, verdict: "unrelated", reason: `URLを扱えない（${n.error}）` };
  if (c.thirdParty || isThirdPartyDomain(n.value.domain, extraThirdParty)) {
    return { ...base, verdict: "third_party", reason: "第三者サイト" };
  }
  const ev = c.evidence;
  if (ev.corporateNumber && company.corporateNumber) {
    return ev.corporateNumber === company.corporateNumber
      ? { ...base, verdict: "verified", reason: "ページ上の法人番号が一致" }
      : { ...base, verdict: "other_company", reason: "ページ上の法人番号が別の法人" };
  }
  if (!ev.companyName || coreName(ev.companyName) !== coreName(company.name)) {
    return { ...base, verdict: "unrelated", reason: "ページ上で社名を確認できない" };
  }
  const addr = compareAddress(company, ev.address);
  if (addr === "match") return { ...base, verdict: "verified", reason: "社名と所在地が一致" };
  if (addr === "mismatch")
    return { ...base, verdict: "other_company", reason: "社名は同じだが所在地が異なる（同名の別企業）" };
  return { ...base, verdict: "probable", reason: "社名は一致、所在地は未確認" };
}

/**
 * 公式URLの確度を判定する（8.1）。
 * - confirmed：法人番号の一致、または社名と所在地の一致をページ上で確認できたサイトがある
 * - candidate：社名は一致するが所在地を確認できないサイトだけがある
 * - needs_review：第三者サイト・同名の別企業・社名を確認できないサイトしか見つからない
 * - not_found：検索結果がない
 * キーワードや検索語に地名が含まれることは根拠にしない。
 */
export function judgeOfficialSite(
  company: CompanyFacts,
  candidates: SiteCandidate[],
  options: { thirdPartyDomains?: readonly string[] } = {},
): OfficialSiteJudgement {
  const seen = new Set<string>();
  const judged: JudgedSite[] = [];
  for (const c of candidates) {
    const j = judgeOne(company, c, options.thirdPartyDomains ?? []);
    if (j.normalizedUrl) {
      if (seen.has(j.normalizedUrl)) continue; // 同じURLの重複（追跡用パラメータ違い等）は1件にする
      seen.add(j.normalizedUrl);
    }
    judged.push(j);
  }
  const verified = judged.filter((j) => j.verdict === "verified");
  if (verified.length > 0) {
    // 法人番号で確認できたものを優先して先頭（主たるサイト）にする
    verified.sort(
      (a, b) => Number(!!b.candidate.evidence.corporateNumber) - Number(!!a.candidate.evidence.corporateNumber),
    );
    return { status: "confirmed", sites: verified, judged, reason: verified[0]!.reason };
  }
  const probable = judged.filter((j) => j.verdict === "probable");
  if (probable.length > 0) return { status: "candidate", sites: probable, judged, reason: probable[0]!.reason };
  if (judged.length > 0) {
    const kinds = [...new Set(judged.map((j) => j.reason))].join("・");
    return { status: "needs_review", sites: [], judged, reason: `公式サイトを確認できない（${kinds}）` };
  }
  return { status: "not_found", sites: [], judged, reason: "検索結果なし" };
}

const RANK: Record<OfficialSiteStatusValue, number> = { not_found: 0, needs_review: 1, candidate: 2, confirmed: 3 };

/** 既に確認済み（confirmed）の企業は、再収集の結果で確度を下げない */
export function mergeOfficialSiteStatus(
  current: OfficialSiteStatusValue,
  next: OfficialSiteStatusValue,
): OfficialSiteStatusValue {
  if (current === "confirmed" && RANK[next] < RANK.confirmed) return current;
  return next;
}
