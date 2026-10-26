import { isUuid } from "./form";
import { OFFICIAL_SITE_LABEL, PIPELINE_LABEL } from "./format";

export const DISCOVERY_JOB_STATES = ["queued", "running", "succeeded", "failed", "needs_review"] as const;
export const DISCOVERY_JOB_PROVIDERS = ["fixture", "nta-corporate-number"] as const;
export type DiscoveryIndexQuery = {
  q: string;
  prefecture: string;
  city: string;
  official: string;
  pipeline: string;
  suppressed: "" | "yes" | "no";
  sourceJob: string;
  companyPage: number;
  jobQuery: string;
  jobStatus: "" | (typeof DISCOVERY_JOB_STATES)[number];
  jobProvider: "" | (typeof DISCOVERY_JOB_PROVIDERS)[number];
  jobsPage: number;
};
const defaults = {
  q: "",
  prefecture: "",
  city: "",
  official: "",
  pipeline: "",
  suppressed: "",
  sourceJob: "",
  companyPage: "1",
  jobQuery: "",
  jobStatus: "",
  jobProvider: "",
  jobsPage: "1",
};
export function parseDiscoveryIndexQuery(search: Record<string, unknown>): DiscoveryIndexQuery | null {
  const value = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const raw = search[key];
    if (raw === undefined) continue;
    if (
      typeof raw !== "string" ||
      raw.length > 120 ||
      Array.from(raw).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return null;
    value[key] = raw.trim();
  }
  if (
    ![value.companyPage, value.jobsPage].every(
      (page) => /^[1-9]\d*$/.test(page) && Number.isSafeInteger(Number(page)),
    ) ||
    (value.sourceJob && !isUuid(value.sourceJob)) ||
    (value.official && !Object.hasOwn(OFFICIAL_SITE_LABEL, value.official)) ||
    (value.pipeline && !Object.hasOwn(PIPELINE_LABEL, value.pipeline)) ||
    !["", "yes", "no"].includes(value.suppressed) ||
    (value.jobStatus && !(DISCOVERY_JOB_STATES as readonly string[]).includes(value.jobStatus)) ||
    (value.jobProvider && !(DISCOVERY_JOB_PROVIDERS as readonly string[]).includes(value.jobProvider))
  )
    return null;
  return { ...value, companyPage: Number(value.companyPage), jobsPage: Number(value.jobsPage) } as DiscoveryIndexQuery;
}
export function discoveryIndexParams(query: DiscoveryIndexQuery) {
  const params = new URLSearchParams();
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const value = String(query[key]);
    if (value && value !== defaults[key]) params.set(key, value);
  }
  return params;
}
export function discoveryIndexHref(query: DiscoveryIndexQuery) {
  const params = discoveryIndexParams(query).toString();
  return `/ops/discovery${params ? `?${params}` : ""}`;
}

/** Only bounded display fields are read from storage, never the full conditions or failure payload. */
export type DiscoveryConditionPreview = {
  prefecture: string | null;
  city: string | null;
  cityCode: string | null;
  industry: string | null;
  keywords: string | null;
  limit: string | null;
};
export function discoveryConditionText(value: DiscoveryConditionPreview) {
  const area = [value.prefecture, value.city].filter(Boolean).join(" ");
  return [
    area || "地域の指定なし",
    value.cityCode && `市区町村コード ${value.cityCode}`,
    value.industry && `業種 ${value.industry}`,
    value.keywords && `企業名 ${value.keywords}`,
    value.limit && `上限 ${value.limit}件`,
  ]
    .filter(Boolean)
    .join(" / ");
}
