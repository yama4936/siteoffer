import { describe, expect, it } from "vitest";
import { checkFacts } from "../src/facts.ts";
import { loadCodexFixture } from "../src/mock.ts";
import { type GenerationInput, type SiteConfig, siteConfigSchema } from "../src/schemas.ts";
import { validateOutput } from "../src/validate.ts";
import { fixtureInput } from "./helpers.ts";

const site = () => structuredClone(loadCodexFixture("demo_site")) as SiteConfig;
function addEmail(input: GenerationInput) {
  input.facts.push({
    key: "company.email",
    label: "メール",
    value: "Contact@example.test",
    status: "confirmed",
    source: "fixture",
  });
}

for (const purpose of ["demo_site", "delivery_site"] as const)
  describe(purpose, () => {
    const validate = (input: GenerationInput, output: SiteConfig) =>
      validateOutput(purpose, input, siteConfigSchema, output);
    it("確認済みの会社名・略称・会社情報・連絡先をそのまま使った構成は通る", () => {
      expect(validate(fixtureInput(), site()).ok).toBe(true);
    });
    it("事実キーが存在しても、別会社の正式名・略称は採用しない", () => {
      for (const field of ["name", "shortName"] as const) {
        const output = site();
        output.company[field] = "別会社の印刷所";
        expect(validate(fixtureInput(), output)).toMatchObject({ ok: false, error: "fact_violation" });
        expect(checkFacts(purpose, fixtureInput(), output)).toContainEqual(
          expect.objectContaining({ path: `company.${field}`, kind: "identity_mismatch" }),
        );
      }
    });
    it("法人格を省いた屋号と確認済みの別名だけを許可する", () => {
      const input = fixtureInput(),
        output = site();
      output.company.shortName = "あおば";
      expect(validate(input, output).ok).toBe(false);
      input.facts.push({
        key: "company.shortName",
        label: "屋号",
        value: "あおば",
        status: "confirmed",
        source: "fixture",
      });
      expect(validate(input, output).ok).toBe(true);
      input.facts.at(-1)!.status = "needs_review";
      expect(validate(input, output).ok).toBe(false);
    });
    it("異なる正式名・会社情報を併せて更新すれば、古い固定社名を要求しない", () => {
      const input = fixtureInput(),
        output = site();
      input.facts.find((f) => f.key === "company.name")!.value = "青葉印刷株式会社";
      output.company.name = "青葉印刷株式会社";
      output.company.shortName = "青葉印刷";
      output.companyInfo!.rows.find((r) => r.factRef === "company.name")!.value = "青葉印刷株式会社";
      expect(validate(input, output).ok).toBe(true);
    });
    it("住所や代表者のfactRefが正しくても、行の値の取り違えを拒否する", () => {
      for (const key of ["company.address", "company.representative", "company.established"] as const) {
        const output = site();
        output.companyInfo!.rows.find((r) => r.factRef === key)!.value = "別の情報";
        expect(validate(fixtureInput(), output)).toMatchObject({ ok: false, error: "fact_violation" });
        expect(checkFacts(purpose, fixtureInput(), output).some((v) => v.kind === "fact_value_mismatch")).toBe(true);
      }
    });
    it("電話の見える表記とtelリンクの両方を照合する", () => {
      for (const field of ["display", "tel"] as const) {
        const output = site();
        output.contact.phone![field] = "052-987-6543";
        expect(validate(fixtureInput(), output)).toMatchObject({ ok: false, error: "fact_violation" });
        expect(checkFacts(purpose, fixtureInput(), output)).toContainEqual(
          expect.objectContaining({ path: `contact.phone.${field}` }),
        );
      }
    });
    it("数字の全半角・電話の区切り表記・メールのドメイン大小文字は許容する", () => {
      const input = fixtureInput(),
        output = site();
      addEmail(input);
      output.contact.phone = { display: "（０００）１１１−２２２２", tel: "0001112222" };
      output.contact.email = "Contact@EXAMPLE.TEST";
      expect(validate(input, output).ok).toBe(true);
      output.contact.phone.display = "TEL:0001112222";
      expect(validate(input, output).ok).toBe(false);
    });
    it("電話がない場合は確認済みのメールだけで制作できる", () => {
      const input = fixtureInput(),
        output = site();
      input.facts = input.facts.filter((f) => f.key !== "company.phone");
      addEmail(input);
      output.contact = { phone: null, email: "Contact@example.test", hours: null, note: null, primary: "email" };
      expect(validate(input, output).ok).toBe(true);
    });
    it("確認した電話・メール・受付時間がない出力や異なる値を拒否する", () => {
      const input = fixtureInput();
      for (const key of ["company.phone", "company.email", "company.hours"]) {
        const output = site();
        const missing = structuredClone(input);
        missing.facts = missing.facts.filter((f) => f.key !== key);
        if (key === "company.email") output.contact.email = "different@example.test";
        expect(validate(missing, output).ok).toBe(false);
      }
      const output = site();
      addEmail(input);
      output.contact.email = "other@example.test";
      expect(validate(input, output).ok).toBe(false);
      output.contact.email = null;
      output.contact.hours = "年中無休";
      expect(validate(input, output).ok).toBe(false);
    });
    it("重複・未確認・欠落した会社名を曖昧なまま採用しない", () => {
      const input = fixtureInput();
      input.facts.push({ ...input.facts.find((f) => f.key === "company.name")! });
      expect(validate(input, site()).ok).toBe(false);
      input.facts = input.facts.filter((f) => f.key !== "company.name");
      expect(validate(input, site()).ok).toBe(false);
      input.facts.push({
        key: "company.name",
        label: "会社名",
        value: site().company.name,
        status: "needs_review",
        source: null,
      });
      expect(validate(input, site()).ok).toBe(false);
    });
    it("一致エラーには掲載した電話やメールの値を含めない", () => {
      const output = site();
      output.contact.phone = { display: "052-987-6543", tel: null };
      const result = validate(fixtureInput(), output);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).not.toContain("052-987-6543");
    });
  });

it("サイト以外の提案文章に構成JSONの会社情報を要求しない", () => {
  expect(checkFacts("proposal_text", fixtureInput(), { company: { name: "別会社" } })).toEqual([]);
});
