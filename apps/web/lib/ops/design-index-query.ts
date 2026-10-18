import type { DesignDraftScope } from "./design-draft-types";

export const DESIGN_HISTORY_STATES = [
  "all",
  "draft",
  "queued",
  "generating",
  "in_review",
  "approved",
  "rejected",
  "failed",
] as const;
export type DesignIndexQuery = {
  companyId: string | null;
  designId: string | "new" | null;
  auditId: string | "none" | null;
  companyQuery: string;
  companyPage: number;
  historyState: (typeof DESIGN_HISTORY_STATES)[number];
  historyPage: number;
};
type Search = Record<string, string | string[] | undefined>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseDesignIndexQuery(search: Search): DesignIndexQuery | null {
  const {
    company,
    design,
    audit,
    companyQuery = "",
    companyPage = "1",
    historyState = "all",
    historyPage = "1",
  } = search;
  if (
    [company, design, audit, companyQuery, companyPage, historyState, historyPage].some(
      (value) => value !== undefined && typeof value !== "string",
    )
  )
    return null;
  if (
    (company !== undefined && !uuid.test(company as string)) ||
    (design !== undefined && (!company || (design !== "new" && !uuid.test(design as string)))) ||
    (audit !== undefined && (!company || (audit !== "none" && !uuid.test(audit as string)))) ||
    (companyQuery as string).length > 120 ||
    Array.from(companyQuery as string).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    ![companyPage, historyPage].every(
      (value) => /^[1-9]\d*$/.test(value as string) && Number.isSafeInteger(Number(value)),
    ) ||
    !DESIGN_HISTORY_STATES.includes(historyState as DesignIndexQuery["historyState"])
  )
    return null;
  return {
    companyId: (company as string | undefined) ?? null,
    designId: (design as string | undefined) ?? null,
    auditId: (audit as string | undefined) ?? null,
    companyQuery: (companyQuery as string).trim(),
    companyPage: Number(companyPage),
    historyState: historyState as DesignIndexQuery["historyState"],
    historyPage: Number(historyPage),
  };
}
export function designIndexParams(query: DesignIndexQuery) {
  const params = new URLSearchParams();
  if (query.companyId) params.set("company", query.companyId);
  if (query.designId) params.set("design", query.designId);
  if (query.auditId) params.set("audit", query.auditId);
  if (query.companyQuery) params.set("companyQuery", query.companyQuery);
  if (query.companyPage !== 1) params.set("companyPage", String(query.companyPage));
  if (query.historyState !== "all") params.set("historyState", query.historyState);
  if (query.historyPage !== 1) params.set("historyPage", String(query.historyPage));
  return params;
}
export function designIndexHref(query: DesignIndexQuery) {
  const params = designIndexParams(query).toString();
  return `/ops/designs${params ? `?${params}` : ""}`;
}
export function keepsDesignScope(query: DesignIndexQuery, scope: DesignDraftScope) {
  return (
    query.companyId === scope.companyId &&
    query.designId === (scope.designId ?? "new") &&
    query.auditId === (scope.auditId ?? "none")
  );
}
