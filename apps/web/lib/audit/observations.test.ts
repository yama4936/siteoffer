import { describe, expect, it } from "vitest";
import { observationHref, readObservations } from "./observations";

it("現行の事実・根拠・参照先と、旧形式の日時を変換せず保持する", () => {
  const value = [
    { fact: "  𠮷野の案内\nあり 👩‍💻", evidence: "本文「相談する」", url: "https://例え.テスト/会社?x=1#案内" },
    { evidence: "保存した写真の下端", fetched_at: "2026-10-14T01:23:45Z", url: null },
  ];
  const before = JSON.stringify(value);
  expect(readObservations(value)).toEqual({
    entries: [
      { fact: value[0]!.fact, evidence: value[0]!.evidence, url: value[0]!.url, href: value[0]!.url, fetchedAt: null },
      { fact: null, evidence: value[1]!.evidence, url: null, href: null, fetchedAt: value[1]!.fetched_at },
    ],
    needsOriginal: false,
  });
  expect(JSON.stringify(value)).toBe(before);
});

it("未知の補足や異常な形式を黙って消さず、原文の確認が必要なことを返す", () => {
  const values = [
    { fact: "事実", quote: "追加の引用" },
    [{ fact: { private: "値" }, evidence: "根拠" }],
    [null, "旧文章", ["配列"], 0, false, {}],
    [{ fact: " ", url: 123, evidence: false }],
  ];
  for (const value of values) {
    const original = JSON.stringify(value);
    const view = readObservations(value);
    expect(view.needsOriginal).toBe(true);
    expect(view.entries).toHaveLength(Array.isArray(value) ? value.length : 1);
    expect(JSON.stringify(value)).toBe(original);
    expect(view.entries.some((entry) => Object.values(entry).includes("[object Object]"))).toBe(false);
  }
});

it("記録なしを観測や低評価で補わず、継承した項目を採用しない", () => {
  for (const value of [null, undefined, []])
    expect(readObservations(value)).toEqual({ entries: [], needsOriginal: false });
  const value = Object.create({ fact: "継承した記述", url: "https://example.test/" });
  expect(readObservations([value])).toEqual({
    entries: [{ fact: null, evidence: null, url: null, href: null, fetchedAt: null }],
    needsOriginal: true,
  });
});

describe("根拠の参照リンク", () => {
  it("保存されたHTTP(S)だけを返し、原文を書き換えない", () => {
    for (const value of ["https://example.test/a?b=1#c", "HTTP://example.test/", "https://例え.テスト/会社"])
      expect(observationHref(value)).toBe(value);
  });
  it("実行可能な形式・相対参照・認証情報・改行・別表記への補完を拒否する", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "file:///C:/private",
      "//example.test",
      "/local",
      "https:example.test",
      "https://",
      "https://user:password@example.test/",
      "https://user@example.test/",
      "https://example.test/\na",
      " https://example.test/",
      "https://example.test/a b",
      "https://example.test/\u007f",
      "https://example.test\\@other.test/",
    ])
      expect(observationHref(value), value).toBeNull();
    const view = readObservations([{ fact: "保存された参照先", url: "javascript:alert(1)" }]);
    expect(view.entries[0]!.url).toBe("javascript:alert(1)");
    expect(view.entries[0]!.href).toBeNull();
  });
});
