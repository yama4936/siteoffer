import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  contractLedgerHref,
  normalizeContractLedgerFilters,
  parseContractLedgerFilters,
} from "./contract-ledger-filters";
import { safeReturnTo, withFlash } from "./form";

it("round-trips full search and focus context without turning search text into URL parameters", () => {
  const focus = randomUUID();
  const filters = {
    q: "架空 & ? status=paid %_\\",
    status: "completed" as const,
    reward: "unpaid" as const,
    sort: "oldest" as const,
    page: 12,
    focus,
  };
  const href = contractLedgerHref(filters);
  const url = new URL(href, "http://local");
  expect(url.pathname).toBe("/ops/contracts");
  expect(url.hash).toBe("#contract-list");
  expect(parseContractLedgerFilters(url.searchParams)).toEqual(filters);
  const back = new URL(withFlash(safeReturnTo(href), { msg: "保存しました" }), "http://local");
  expect(parseContractLedgerFilters(back.searchParams)).toEqual(filters);
  expect(back.hash).toBe("#contract-list");
});

it("rejects duplicated, malformed and oversized filters rather than silently widening the search", () => {
  for (const query of [
    "q=a&q=b",
    "status=all&status=completed",
    "page=0",
    "page=-1",
    "page=1e2",
    "page=1.5",
    "page=9007199254740992",
    "reward=__proto__",
    "status=missing",
    "sort=missing",
    "focus=not-an-id",
    `q=${"a".repeat(201)}`,
  ])
    expect(parseContractLedgerFilters(new URLSearchParams(query)), query).toBeNull();
  for (const input of [{ q: null }, { status: null }, { reward: false }, { sort: [] }, { page: Number.NaN }])
    expect(normalizeContractLedgerFilters(input as never)).toBeNull();
});

it("normalizes empty search, defaults and uppercase focus IDs", () => {
  const id = randomUUID();
  expect(parseContractLedgerFilters(new URLSearchParams({ q: "   ", focus: id.toUpperCase() }))).toEqual({
    q: "",
    status: "all",
    reward: "all",
    sort: "attention",
    page: 1,
    focus: id,
  });
});
