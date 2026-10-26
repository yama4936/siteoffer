import { isUuid } from "./form";

export const AUDIT_HISTORY_STATUS = {
  all: "すべて",
  queued: "開始待ち",
  collecting: "取得中",
  scoring: "採点中",
  evaluated: "評価済み",
  unevaluable: "評価不能",
  failed: "失敗",
};
export type AuditHistoryQuery = {
  status: keyof typeof AUDIT_HISTORY_STATUS;
  sort: "newest" | "oldest";
  page: number;
  audit?: string;
};
export function parseAuditHistoryQuery(params: URLSearchParams): AuditHistoryQuery | null {
  for (const key of ["status", "sort", "page", "audit"]) if (params.getAll(key).length > 1) return null;
  const status = params.get("status") ?? "all",
    sort = params.get("sort") ?? "newest",
    rawPage = params.get("page") ?? "1",
    audit = params.get("audit");
  if (
    !Object.hasOwn(AUDIT_HISTORY_STATUS, status) ||
    !["newest", "oldest"].includes(sort) ||
    !/^[1-9]\d*$/.test(rawPage) ||
    !Number.isSafeInteger(Number(rawPage)) ||
    Number(rawPage) > 2147483647 ||
    (audit !== null && !isUuid(audit))
  )
    return null;
  return {
    status: status as AuditHistoryQuery["status"],
    sort: sort as AuditHistoryQuery["sort"],
    page: Number(rawPage),
    ...(audit ? { audit: audit.toLowerCase() } : {}),
  };
}
export function auditHistoryHref(companyId: string, input: Partial<AuditHistoryQuery> = {}, detail = false) {
  if (!isUuid(companyId)) throw Error("Invalid company ID");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, String(value));
  const query = parseAuditHistoryQuery(params);
  if (!query) throw Error("Invalid audit history query");
  const canonical = new URLSearchParams();
  if (query.status !== "all") canonical.set("status", query.status);
  if (query.sort !== "newest") canonical.set("sort", query.sort);
  if (query.page > 1) canonical.set("page", String(query.page));
  if (query.audit) canonical.set("audit", query.audit);
  return `/ops/companies/${companyId.toLowerCase()}/audits${canonical.size ? `?${canonical}` : ""}${detail ? "#audit-detail" : ""}`;
}
