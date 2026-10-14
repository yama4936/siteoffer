import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findMarkers, splitMarkers } from "../lib/markers.ts";
import { resolveMode, textColorOn, validateSiteInput, visibleSections } from "../lib/resolve.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}/site.json`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;

describe("入力スキーマ", () => {
  it("3種のフィクスチャが検証を通る", () => {
    for (const name of ["full", "no-works", "needs-confirm"]) {
      expect(validateSiteInput(fixture(name)).ok, name).toBe(true);
    }
  });

  it("色の形式違い・primary の不整合・外部画像URLを拒否する", () => {
    const bad = fixture("full");
    bad.theme = { brand: "red;}body{display:none", accent: "#000000" };
    (bad.contact as Record<string, unknown>).primary = "email";
    delete (bad.contact as Record<string, unknown>).email;
    (bad.hero as Record<string, unknown>).image = { src: "https://example.com/x.png", alt: "x" };
    const r = validateSiteInput(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.startsWith("theme.brand"))).toBe(true);
      expect(r.errors.some((e) => e.startsWith("contact.primary"))).toBe(true);
      expect(r.errors.some((e) => e.startsWith("hero.image.src"))).toBe(true);
    }
  });

  it("実績が空なら works セクションを出さず、順序は入力どおり", () => {
    const r = validateSiteInput(fixture("no-works"));
    if (!r.ok) throw new Error("invalid");
    expect(visibleSections(r.input).map((s) => s.type)).toEqual(["services", "contact", "company"]);
  });
});

describe("要確認マーカー", () => {
  it("位置と説明を列挙する（全角コロンも可）", () => {
    const r = validateSiteInput(fixture("needs-confirm"));
    if (!r.ok) throw new Error("invalid");
    expect(r.markers.map((m) => m.path)).toEqual([
      "hero.lead",
      "companyInfo.rows[1].value",
      "companyInfo.rows[2].value",
      "works.items[0].title",
      "contact.phone.display",
    ]);
    expect(findMarkers({ a: "{{要確認：設立年}}" })).toEqual([{ path: "a", note: "設立年" }]);
  });

  it("文とマーカーに分割する", () => {
    expect(splitMarkers("前{{要確認:X}}後")).toEqual([
      { kind: "text", text: "前" },
      { kind: "marker", note: "X" },
      { kind: "text", text: "後" },
    ]);
  });
});

describe("モードと色", () => {
  it("優先順は 引数 > 環境変数 > 入力 > demo", () => {
    expect(resolveMode({})).toBe("demo");
    expect(resolveMode({ input: "delivery" })).toBe("delivery");
    expect(resolveMode({ env: "demo", input: "delivery" })).toBe("demo");
    expect(resolveMode({ explicit: "delivery", env: "demo" })).toBe("delivery");
    expect(() => resolveMode({ env: "prod" })).toThrow();
  });

  it("背景色に応じて読みやすい文字色を選ぶ", () => {
    expect(textColorOn("#1f3a68")).toBe("#ffffff");
    expect(textColorOn("#f2c14e")).toBe("#1a1a1a");
  });
});
