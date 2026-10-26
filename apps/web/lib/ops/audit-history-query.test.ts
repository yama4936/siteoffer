import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { auditHistoryHref, parseAuditHistoryQuery } from "./audit-history-query";

it("既定値と状態・並び順・ページ・選択番号をURLで保持する", () => {
  const id = randomUUID(),
    audit = randomUUID();
  expect(parseAuditHistoryQuery(new URLSearchParams())).toEqual({ status: "all", sort: "newest", page: 1 });
  const href = auditHistoryHref(
      id.toUpperCase(),
      { status: "failed", sort: "oldest", page: 3, audit: audit.toUpperCase() },
      true,
    ),
    url = new URL(href, "https://local.test");
  expect(url.pathname).toBe(`/ops/companies/${id}/audits`);
  expect(url.hash).toBe("#audit-detail");
  expect(parseAuditHistoryQuery(url.searchParams)).toEqual({ status: "failed", sort: "oldest", page: 3, audit });
});
it("重複したパラメーター・不正値・大きすぎるページ・不正な番号を拒否する", () => {
  for (const raw of [
    "status=all&status=failed",
    "sort=newest&sort=oldest",
    "page=1&page=2",
    "audit=x&audit=y",
    "status=constructor",
    "sort=bad",
    "page=0",
    "page=-1",
    "page=1e2",
    "page=01",
    "page=2147483648",
    "audit=",
  ])
    expect(parseAuditHistoryQuery(new URLSearchParams(raw)), raw).toBeNull();
  expect(() => auditHistoryHref("bad")).toThrow();
  expect(() => auditHistoryHref(randomUUID(), { page: 0 })).toThrow();
});
