import { describe, expect, it } from "vitest";
import { accountsHref, MAX_RECOVERY_PAGE, parseAccountsQuery, userFilterOf } from "./accounts-query";
import { safeReturnTo, withFlash } from "./form";

function spOf(href: string) {
  const url = new URL(href, "http://local");
  return Object.fromEntries(url.searchParams.entries());
}

describe("アカウント管理の絞り込み条件", () => {
  it("条件なしは既定値で、URL にクエリを付けない", () => {
    expect(parseAccountsQuery({})).toEqual({ role: "all", status: "all", history: false, page: 0 });
    expect(accountsHref()).toBe("/ops/accounts");
    expect(userFilterOf(parseAccountsQuery({}))).toEqual({});
  });

  it("役割・状態・history・page を URL と行き来できる", () => {
    const q = { role: "sales", status: "suspended", history: true, page: 3 } as const;
    const href = accountsHref(q);
    expect(new URL(href, "http://local").pathname).toBe("/ops/accounts");
    expect(parseAccountsQuery(spOf(href))).toEqual(q);
    expect(userFilterOf(q)).toEqual({ role: "sales", status: "suspended" });
    // 操作後の戻り先（msg 付き）でも条件が残る
    const back = withFlash(safeReturnTo(href), { msg: "利用停止にしました" });
    expect(parseAccountsQuery(spOf(back))).toEqual(q);
  });

  it("分からない値・不正な page は既定値に戻す", () => {
    expect(parseAccountsQuery({ role: "admin", status: "__proto__", history: "true", page: "-1" })).toEqual({
      role: "all",
      status: "all",
      history: false,
      page: 0,
    });
    for (const page of ["1.5", "1e2", "abc", ""]) expect(parseAccountsQuery({ page }).page).toBe(0);
    expect(parseAccountsQuery({ page: "99999999999999999999" }).page).toBe(0);
    expect(parseAccountsQuery({ page: String(MAX_RECOVERY_PAGE + 5) }).page).toBe(MAX_RECOVERY_PAGE);
  });

  it("同じキーが複数ある場合は先頭を使う", () => {
    expect(parseAccountsQuery({ role: ["customer", "ops"], history: ["1", "0"] })).toMatchObject({
      role: "customer",
      history: true,
    });
  });

  it("ページ送りの URL は絞り込み条件を保ち、0ページ目は page を省く", () => {
    expect(accountsHref({ role: "customer", history: false, page: 0 }, "recovery")).toBe(
      "/ops/accounts?role=customer#recovery",
    );
    expect(accountsHref({ history: true, page: 2 })).toBe("/ops/accounts?history=1&page=2");
    expect(accountsHref({ page: -4 })).toBe("/ops/accounts");
  });
});
