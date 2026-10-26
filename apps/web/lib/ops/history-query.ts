export type HistoryQuery = {
  view: "work" | "access" | "all";
  q: string;
  action: string;
  targetType: string;
  targetId: string;
  actor: string;
  from: string;
  to: string;
  page: number;
};
const defaults = {
  view: "work",
  q: "",
  action: "",
  targetType: "",
  targetId: "",
  actor: "",
  from: "",
  to: "",
  page: "1",
};
export const HISTORY_VIEWS = { work: "案件・設定の操作", access: "ログイン・ログアウト", all: "すべての操作" } as const;
export const HISTORY_ACTORS: Record<string, string> = {
  ops: "運営",
  sales: "営業",
  customer: "顧客（確認リンク）",
  customer_user: "顧客（ログイン）",
  system: "自動処理",
};
/** Date filters use Japan time and an inclusive end day, regardless of the server timezone. */
export function historyDate(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number(day.slice(0, 4)) === 0) return null;
  const date = new Date(`${day}T00:00:00+09:00`);
  return Number.isFinite(date.getTime()) && new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 10) === day
    ? date
    : null;
}
export function parseHistoryQuery(input: Record<string, unknown>): HistoryQuery | null {
  const values = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (
      typeof raw !== "string" ||
      raw.length > (key === "targetId" ? 300 : 120) ||
      Array.from(raw).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return null;
    values[key] = raw.trim();
  }
  if (
    !Object.hasOwn(HISTORY_VIEWS, values.view) ||
    !/^[1-9]\d*$/.test(values.page) ||
    !Number.isSafeInteger(Number(values.page)) ||
    Number(values.page) > 2147483647 ||
    (values.actor && !Object.hasOwn(HISTORY_ACTORS, values.actor)) ||
    (values.from && !historyDate(values.from)) ||
    (values.to && !historyDate(values.to)) ||
    (values.from && values.to && values.from > values.to)
  )
    return null;
  return { ...values, view: values.view as HistoryQuery["view"], page: Number(values.page) };
}
export function historyParams(value: HistoryQuery) {
  const params = new URLSearchParams();
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[])
    if (String(value[key]) !== defaults[key]) params.set(key, String(value[key]));
  return params;
}
export function historyHref(value: HistoryQuery, changes: Partial<HistoryQuery> = {}) {
  const params = historyParams({ ...value, ...changes });
  return `/ops/history${params.size ? `?${params}` : ""}`;
}
