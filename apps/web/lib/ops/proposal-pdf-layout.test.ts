import { expect, it } from "vitest";
import { compactPdfHeader, wrapPdfText } from "./proposal-pdf-layout";

const width = (text: string) => Array.from(text).reduce((sum, ch) => sum + (ch.charCodeAt(0) < 128 ? 1 : 2), 0);
it("wraps Japanese names, long URLs and mixed text without losing a character", () => {
  for (const text of ["AB会社CD", "長い会社名".repeat(30), `https://example.test/${"a-b/".repeat(70)}`]) {
    const lines = wrapPdfText(text, width, 12);
    expect(lines.join("")).toBe(text);
    expect(lines.every((line) => width(line) <= 12)).toBe(true);
  }
});
it("normalizes control characters and retains explicit blank lines", () => {
  expect(wrapPdfText("A\r\n\r\nB\rC\tD\u0000", width, 12)).toEqual(["A", "", "B", "C  D"]);
});
it("keeps combining marks and emoji sequences within the same text fragment", () => {
  const measure = (text: string) => (text === "か\u3099" || text === "👨‍👩‍👧‍👦" ? 2 : width(text));
  expect(wrapPdfText("AAか\u3099B👨‍👩‍👧‍👦", measure, 4)).toEqual(["AAか\u3099", "B👨‍👩‍👧‍👦"]);
});
it("abbreviates only repeated headers and keeps the measured suffix within the margin", () => {
  const text = "長い会社名を表紙では省略せずに掲載します";
  const lines = compactPdfHeader(text, width, 12);
  expect(lines).toHaveLength(2);
  expect(lines[1]?.endsWith("...")).toBe(true);
  expect(lines.every((line) => width(line) <= 12)).toBe(true);
  expect(wrapPdfText(text, width, 12).join("")).toBe(text);
  expect(compactPdfHeader("AB  CD", width, 12)).toEqual(["AB CD"]);
});
it("rejects impossible widths and invalid font measurements rather than clipping", () => {
  for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => wrapPdfText("text", width, size)).toThrow(RangeError);
  expect(() => wrapPdfText("会", width, 1)).toThrow(RangeError);
  expect(() => wrapPdfText("text", () => Number.NaN, 12)).toThrow(RangeError);
  expect(() => compactPdfHeader("text", width, 12, 0)).toThrow(RangeError);
});
