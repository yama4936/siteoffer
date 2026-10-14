/**
 * サイト構成（demo_site / delivery_site）の出力スキーマが、テンプレートの SiteInputSchema と同じ形であることの確認。
 * 実際のビルドは templates/astro-site/test/generation-fixture.test.ts で1回だけ行う。
 */
import { describe, expect, it } from "vitest";
import { toCodexOutputSchema } from "../src/json-schema.ts";
import { loadCodexFixture } from "../src/mock.ts";
import {
  generationOutputSchemas,
  type SiteConfig,
  SiteInputSchema,
  siteConfigSchema,
  siteGenerationToSiteInput,
  siteInputToSiteGeneration,
} from "../src/schemas.ts";
import { validateOutput } from "../src/validate.ts";
import { clone, fixtureInput } from "./helpers.ts";

const purposes = ["demo_site", "delivery_site"] as const;

describe("サイト構成の出力 = テンプレート入力", () => {
  it("用途の既定スキーマはテンプレート側のスキーマそのもの", () => {
    expect(generationOutputSchemas.demo_site).toBe(siteConfigSchema);
    expect(generationOutputSchemas.delivery_site).toBe(siteConfigSchema);
  });

  for (const p of purposes) {
    it(`${p} の固定応答はテンプレート入力に変換でき、SiteInputSchema に通り、逆変換で元に戻る`, () => {
      const out = siteConfigSchema.parse(loadCodexFixture(p));
      const input = siteGenerationToSiteInput(out);
      const parsed = SiteInputSchema.safeParse(input);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      // null の項目は省かれ、factRef は来歴として残る
      expect(input.hero.lead).toBeTypeOf("string");
      expect(input.meta).not.toHaveProperty("title");
      expect(input.works?.items[0]?.factRef).toBe("achievement.yearly");
      expect(siteInputToSiteGeneration(input)).toEqual({ ok: true, output: out });
    });
  }

  it("テンプレートの検査（連絡先の組み合わせ等）は生成の出力の検証でも働く", () => {
    const s = clone(loadCodexFixture("demo_site")) as SiteConfig;
    s.contact.phone = null; // primary は phone のまま、メールもない
    const r = validateOutput("demo_site", fixtureInput(), siteConfigSchema, s);
    expect(r).toMatchObject({ ok: false, error: "schema_violation" });
    if (!r.ok) expect(r.message).toContain("テンプレート入力として不正");

    const dup = clone(loadCodexFixture("demo_site")) as SiteConfig;
    dup.sections.push({ type: "services", visible: true, heading: null });
    expect(siteConfigSchema.safeParse(dup).success).toBe(false);
  });

  it("生成に任せない項目（画像・mode）は出力に書けない", () => {
    const s = clone(loadCodexFixture("demo_site")) as Record<string, unknown>;
    expect(siteConfigSchema.safeParse({ ...s, mode: "delivery" }).success).toBe(false);
    const withImage = clone(loadCodexFixture("demo_site")) as { hero: Record<string, unknown> };
    withImage.hero.image = { src: "images/hero.png", alt: "外観" };
    expect(siteConfigSchema.safeParse(withImage).success).toBe(false);
  });

  it("Codexに渡すJSON Schemaは全項目が必須で、追加の項目を許さない（厳格な構造化出力の形）", () => {
    const schema = toCodexOutputSchema(siteConfigSchema);
    expect(JSON.stringify(schema)).not.toContain("oneOf");
    const objects: Array<Record<string, unknown>> = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (o.type === "object" && o.properties) objects.push(o);
        Object.values(o).forEach(walk);
      }
    };
    walk(schema);
    expect(objects.length).toBeGreaterThan(5);
    for (const o of objects) {
      expect(o.additionalProperties).toBe(false);
      expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
    }
  });
});
