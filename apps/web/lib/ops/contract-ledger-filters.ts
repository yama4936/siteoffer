import { isUuid } from "./form";

export const CONTRACT_LEDGER_STATUS = {
  all: "すべての契約",
  pending: "契約の確認待ち",
  reported: "成約報告（未確認）",
  under_review: "確認中",
  completed: "契約完了",
  rejected: "差し戻し",
  cancelled: "取消",
};
export const CONTRACT_LEDGER_REWARD = {
  all: "すべての報酬",
  unpaid: "報酬の支払待ち",
  none: "報酬未発生",
  accrued: "発生",
  scheduled: "支払予定",
  paid: "支払済み",
  cancelled: "取消",
};
export const CONTRACT_LEDGER_SORT = {
  attention: "確認・支払待ちを先に",
  newest: "報告が新しい順",
  oldest: "報告が古い順",
};
export type ContractLedgerFilters = {
  q: string;
  status: keyof typeof CONTRACT_LEDGER_STATUS;
  reward: keyof typeof CONTRACT_LEDGER_REWARD;
  sort: keyof typeof CONTRACT_LEDGER_SORT;
  page: number;
  focus?: string;
};

export function normalizeContractLedgerFilters(
  input: Partial<ContractLedgerFilters> = {},
): ContractLedgerFilters | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const q = input.q === undefined ? "" : input.q;
  const status = input.status === undefined ? "all" : input.status;
  const reward = input.reward === undefined ? "all" : input.reward;
  const sort = input.sort === undefined ? "attention" : input.sort;
  const page = input.page === undefined ? 1 : input.page;
  if (
    typeof q !== "string" ||
    q.length > 200 ||
    typeof status !== "string" ||
    !Object.hasOwn(CONTRACT_LEDGER_STATUS, status) ||
    typeof reward !== "string" ||
    !Object.hasOwn(CONTRACT_LEDGER_REWARD, reward) ||
    typeof sort !== "string" ||
    !Object.hasOwn(CONTRACT_LEDGER_SORT, sort) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 2147483647 ||
    (input.focus !== undefined && !isUuid(input.focus))
  )
    return null;
  return { q: q.trim(), status, reward, sort, page, ...(input.focus ? { focus: input.focus.toLowerCase() } : {}) };
}

export function parseContractLedgerFilters(params: URLSearchParams) {
  for (const key of ["q", "status", "reward", "sort", "page", "focus"]) if (params.getAll(key).length > 1) return null;
  const page = params.get("page");
  if (page !== null && !/^[1-9]\d*$/.test(page)) return null;
  return normalizeContractLedgerFilters({
    q: params.get("q") ?? "",
    status: (params.get("status") ?? "all") as ContractLedgerFilters["status"],
    reward: (params.get("reward") ?? "all") as ContractLedgerFilters["reward"],
    sort: (params.get("sort") ?? "attention") as ContractLedgerFilters["sort"],
    page: page === null ? 1 : Number(page),
    ...(params.has("focus") ? { focus: params.get("focus")! } : {}),
  });
}

export function contractLedgerHref(input: Partial<ContractLedgerFilters> = {}) {
  const filters = normalizeContractLedgerFilters(input);
  if (!filters) throw new Error("Invalid contract list filters");
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.reward !== "all") params.set("reward", filters.reward);
  if (filters.sort !== "attention") params.set("sort", filters.sort);
  if (filters.page > 1) params.set("page", String(filters.page));
  if (filters.focus) params.set("focus", filters.focus);
  return `/ops/contracts${params.size ? `?${params}` : ""}#contract-list`;
}
