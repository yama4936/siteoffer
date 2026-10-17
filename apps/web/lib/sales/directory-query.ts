export const COMPANY_SORTS = ["score_asc", "score_desc", "region"] as const;
export type CompanySort = (typeof COMPANY_SORTS)[number];
export const DIRECTORY_ASSIGNMENTS = {
  all: "すべて",
  none: "担当者なし",
  mine: "自分の担当",
  other: "他の営業が担当",
} as const;
export type DirectoryAssignment = keyof typeof DIRECTORY_ASSIGNMENTS;
export interface CompanyListFilter {
  prefecture?: string | undefined;
  city?: string | undefined;
  industry?: string | undefined;
  sort?: CompanySort | undefined;
  query?: string | undefined;
  assignment?: DirectoryAssignment | undefined;
  page?: number | undefined;
}
export type DirectoryQuery = Required<CompanyListFilter>;
export const parseCompanySort = (v: string | undefined): CompanySort =>
  COMPANY_SORTS.includes(v as CompanySort) ? (v as CompanySort) : "score_asc";

export function normalizeDirectoryFilter(input: CompanyListFilter): DirectoryQuery | null {
  const { page = 1, sort = "score_asc", assignment = "all" } = input;
  const values = [input.query ?? "", input.prefecture ?? "", input.city ?? "", input.industry ?? ""];
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !COMPANY_SORTS.includes(sort) ||
    !Object.hasOwn(DIRECTORY_ASSIGNMENTS, assignment) ||
    values.some(
      (v) =>
        typeof v !== "string" ||
        v.length > 120 ||
        Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    )
  )
    return null;
  return {
    query: values[0]!.trim(),
    prefecture: values[1]!.trim(),
    city: values[2]!.trim(),
    industry: values[3]!.trim(),
    page,
    sort,
    assignment,
  };
}
export function parseDirectoryQuery(sp: Record<string, string | string[] | undefined>): DirectoryQuery | null {
  const keys = ["q", "prefecture", "city", "industry", "sort", "assignment", "page"];
  if (keys.some((k) => sp[k] !== undefined && typeof sp[k] !== "string")) return null;
  const page = sp.page ?? "1";
  if (typeof page !== "string" || !/^[1-9]\d*$/.test(page)) return null;
  return normalizeDirectoryFilter({
    query: sp.q as string | undefined,
    prefecture: sp.prefecture as string | undefined,
    city: sp.city as string | undefined,
    industry: sp.industry as string | undefined,
    sort: sp.sort as CompanySort | undefined,
    assignment: sp.assignment as DirectoryAssignment | undefined,
    page: Number(page),
  });
}
export function directoryParams(query: DirectoryQuery) {
  const params = new URLSearchParams();
  if (query.query) params.set("q", query.query);
  for (const key of ["prefecture", "city", "industry"] as const) if (query[key]) params.set(key, query[key]);
  if (query.sort !== "score_asc") params.set("sort", query.sort);
  if (query.assignment !== "all") params.set("assignment", query.assignment);
  if (query.page !== 1) params.set("page", String(query.page));
  return params;
}
export function directoryHref(base: string, query: DirectoryQuery) {
  const params = directoryParams(query);
  return base + (params.size ? `?${params}` : "");
}
