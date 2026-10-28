/**
 * アカウント管理（/ops/accounts）の絞り込み条件。
 * ユーザー一覧の役割・状態と、パスワード再設定一覧の history・page を URL から読み、URL に戻す。
 */

export const ACCOUNTS_PATH = "/ops/accounts";

export const ACCOUNT_ROLE = { all: "すべての役割", sales: "営業", customer: "顧客", ops: "運営" } as const;
export const ACCOUNT_STATUS = { all: "すべての状態", active: "利用中", suspended: "利用停止" } as const;

/** 再設定一覧の page は 0 始まり（listPasswordRecoveries に合わせる）。上限は旧画面と同じ */
export const MAX_RECOVERY_PAGE = 100000;

export type AccountsQuery = {
  role: keyof typeof ACCOUNT_ROLE;
  status: keyof typeof ACCOUNT_STATUS;
  history: boolean;
  page: number;
};

type SearchParams = Record<string, string | string[] | undefined>;

const DEFAULTS: AccountsQuery = { role: "all", status: "all", history: false, page: 0 };

function single(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * URL の条件を読む。分からない値は既定値に戻す（GET フォームと旧画面のリンクを壊さないため）。
 */
export function parseAccountsQuery(sp: SearchParams): AccountsQuery {
  const role = single(sp, "role");
  const status = single(sp, "status");
  const rawPage = single(sp, "page");
  const page = rawPage !== undefined && /^\d+$/.test(rawPage) ? Number(rawPage) : 0;
  return {
    role: role !== undefined && Object.hasOwn(ACCOUNT_ROLE, role) ? (role as AccountsQuery["role"]) : "all",
    status: status !== undefined && Object.hasOwn(ACCOUNT_STATUS, status) ? (status as AccountsQuery["status"]) : "all",
    history: single(sp, "history") === "1",
    page: Number.isSafeInteger(page) ? Math.min(page, MAX_RECOVERY_PAGE) : 0,
  };
}

/** listUsersForOps に渡す絞り込み（「すべて」は条件なし） */
export function userFilterOf(q: AccountsQuery): {
  role?: "sales" | "customer" | "ops";
  status?: "active" | "suspended";
} {
  return {
    ...(q.role === "all" ? {} : { role: q.role }),
    ...(q.status === "all" ? {} : { status: q.status }),
  };
}

/** 条件から /ops/accounts の URL を作る。既定値は URL に出さない */
export function accountsHref(input: Partial<AccountsQuery> = {}, hash?: string): string {
  const q = { ...DEFAULTS, ...input };
  const params = new URLSearchParams();
  if (q.role !== "all") params.set("role", q.role);
  if (q.status !== "all") params.set("status", q.status);
  if (q.history) params.set("history", "1");
  const page = Number.isSafeInteger(q.page) && q.page > 0 ? Math.min(q.page, MAX_RECOVERY_PAGE) : 0;
  if (page > 0) params.set("page", String(page));
  const query = params.toString();
  return `${ACCOUNTS_PATH}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`;
}
