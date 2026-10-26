import { describe, expect, it } from "vitest";
import { jstDate, optInt, safeReturnTo, withFlash } from "./form";

describe("運営画面のフォーム読み取り", () => {
  it("戻り先は /ops 配下だけ", () => {
    expect(safeReturnTo("/ops/companies?x=1")).toBe("/ops/companies?x=1");
    expect(safeReturnTo("/ops")).toBe("/ops");
    for (const bad of ["https://evil.example", "//evil.example", "/opsx", "/sales", "/ops\\..", null]) {
      expect(safeReturnTo(bad)).toBe("/ops");
    }
  });

  it("結果の文言を付け替える", () => {
    expect(withFlash("/ops/a?msg=old&q=1", { error: "失敗" })).toBe(
      `/ops/a?q=1&error=${encodeURIComponent("失敗").replace(/%20/g, "+")}`,
    );
  });

  it("日時は日本時間として読む。整数は空欄なら null、不正なら NaN", () => {
    const fd = new FormData();
    fd.set("d", "2026-10-20");
    fd.set("dt", "2026-10-20T09:30");
    fd.set("n", "1,000");
    fd.set("bad", "1.5");
    expect(jstDate(fd, "d")?.toISOString()).toBe("2026-10-19T15:00:00.000Z");
    expect(jstDate(fd, "dt")?.toISOString()).toBe("2026-10-20T00:30:00.000Z");
    expect(jstDate(fd, "none")).toBeNull();
    expect(optInt(fd, "n")).toBe(1000);
    expect(optInt(fd, "none")).toBeNull();
    expect(optInt(fd, "bad")).toBeNaN();
  });
});

it("結果メッセージを付けても対象案件のアンカーと絞り込みを保つ", () => {
  const path = withFlash("/ops/delivery?focus=fixture&error=old#delivery-fixture", { msg: "完了" });
  const url = new URL(path, "https://example.test");
  expect(url.searchParams.get("focus")).toBe("fixture");
  expect(url.searchParams.get("msg")).toBe("完了");
  expect(url.searchParams.has("error")).toBe(false);
  expect(url.hash).toBe("#delivery-fixture");
  expect(withFlash("/ops/delivery#domain-preferences", {})).toBe("/ops/delivery#domain-preferences");
});
