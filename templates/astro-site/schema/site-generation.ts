/**
 * 生成（Codex。用途 demo_site / delivery_site）が出力するサイト構成JSONの形と、テンプレート入力（SiteInput）との変換。
 *
 * - 正は schema/site-input.ts の SiteInputSchema。ここではその同じ形（同じフィールド名・入れ子）から、
 *   Codexの構造化出力に渡せる形を作る：オブジェクトはすべて strict、省略可能な項目は作らず、不明な値は null。
 * - 生成に任せないもの（mode・lang・画像・デモの宛名・著作権表記）は含めない。画像は素材の確認後に運営が足す。
 * - 会社情報の行と実績には、根拠にした確認済み事実のキー（factRef）を必須にする（生成側の事実検査で照合する）。
 * - 検証（superRefine）でテンプレート入力に変換して SiteInputSchema でも確かめるので、
 *   この検証に通った出力はそのままテンプレートのビルドに渡せる。
 *
 * 依存の向き：packages/schemas → このファイル。テンプレートはSiteOfferの他のパッケージに依存しない
 * （ビルド用コンテナにテンプレートだけを入れられるようにするため）。
 */
import { z } from "zod";
import { HexColorSchema, SectionTypeSchema, type SiteInputRaw, SiteInputSchema, type SiteMode } from "./site-input.ts";

const text = z.string().min(1);
const nullableText = text.nullable();

const SiteGenerationShape = z.strictObject({
  schemaVersion: z.literal(1),
  company: z.strictObject({
    name: text,
    shortName: nullableText,
  }),
  meta: z.strictObject({
    title: nullableText,
    description: text,
  }),
  theme: z.strictObject({
    brand: HexColorSchema,
    accent: HexColorSchema,
  }),
  hero: z.strictObject({
    catchcopy: text,
    lead: nullableText,
  }),
  sections: z
    .array(
      z.strictObject({
        type: SectionTypeSchema,
        visible: z.boolean(),
        heading: nullableText,
      }),
    )
    .min(1),
  services: z
    .strictObject({
      intro: nullableText,
      items: z.array(z.strictObject({ title: text, description: text })).min(1),
    })
    .nullable(),
  /** 会社情報の表。各行は確認済み事実の値をそのまま使い、factRef にそのキーを書く。なければ null */
  companyInfo: z
    .strictObject({
      intro: nullableText,
      rows: z.array(z.strictObject({ label: text, value: text, factRef: text })).min(1),
    })
    .nullable(),
  /** 実績。確認済み事実に対応するものだけ（factRef 必須）。なければ null */
  works: z
    .strictObject({
      intro: nullableText,
      items: z.array(
        z.strictObject({
          title: text,
          description: nullableText,
          period: nullableText,
          factRef: text,
        }),
      ),
    })
    .nullable(),
  contact: z.strictObject({
    phone: z.strictObject({ display: text, tel: nullableText }).nullable(),
    email: nullableText,
    hours: nullableText,
    note: nullableText,
    primary: z.enum(["phone", "email"]),
  }),
});

export type SiteGenerationOutput = z.infer<typeof SiteGenerationShape>;

/** 生成の出力スキーマ。テンプレート入力に変換した結果も SiteInputSchema で検証する */
export const SiteGenerationOutputSchema = SiteGenerationShape.superRefine((v, ctx) => {
  const parsed = SiteInputSchema.safeParse(siteGenerationToSiteInput(v));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: `テンプレート入力として不正: ${issue.message}` });
    }
  }
});

/** null の項目を省く（テンプレート入力は省略可能な項目を undefined で表す） */
function opt<T>(v: T | null): T | undefined {
  return v === null ? undefined : v;
}

export interface ToSiteInputOptions {
  /** ビルドのモードを入力JSONに書く場合に指定する。省略時はビルド時の指定に任せる */
  mode?: SiteMode;
}

/** 生成の出力 → テンプレート入力（site.json）。factRef は来歴として残す（表示には使わない） */
export function siteGenerationToSiteInput(out: SiteGenerationOutput, options: ToSiteInputOptions = {}): SiteInputRaw {
  const input: SiteInputRaw = {
    schemaVersion: 1,
    company: { name: out.company.name, shortName: opt(out.company.shortName) },
    meta: { title: opt(out.meta.title), description: out.meta.description },
    theme: { brand: out.theme.brand, accent: out.theme.accent },
    hero: { catchcopy: out.hero.catchcopy, lead: opt(out.hero.lead) },
    sections: out.sections.map((s) => ({ type: s.type, visible: s.visible, heading: opt(s.heading) })),
    services: out.services
      ? {
          intro: opt(out.services.intro),
          items: out.services.items.map((i) => ({ title: i.title, description: i.description })),
        }
      : undefined,
    companyInfo: out.companyInfo
      ? {
          intro: opt(out.companyInfo.intro),
          rows: out.companyInfo.rows.map((r) => ({ label: r.label, value: r.value, factRef: r.factRef })),
        }
      : undefined,
    works: out.works
      ? {
          intro: opt(out.works.intro),
          items: out.works.items.map((i) => ({
            title: i.title,
            description: opt(i.description),
            period: opt(i.period),
            factRef: i.factRef,
          })),
        }
      : undefined,
    contact: {
      phone: out.contact.phone ? { display: out.contact.phone.display, tel: opt(out.contact.phone.tel) } : undefined,
      email: opt(out.contact.email),
      hours: opt(out.contact.hours),
      note: opt(out.contact.note),
      primary: out.contact.primary,
    },
  };
  if (options.mode) input.mode = options.mode;
  return JSON.parse(JSON.stringify(input)) as SiteInputRaw; // undefined のキーを落とす
}

export type ToGenerationResult = { ok: true; output: SiteGenerationOutput } | { ok: false; errors: string[] };

/**
 * テンプレート入力 → 生成の出力の形（再生成で既存の構成を土台として渡すときなどに使う）。
 * mode・lang・画像・demo・footer は生成の出力に含めないので落とす。
 * 会社情報の行・実績に factRef がない入力は、根拠を辿れないので変換しない（errors を返す）。
 */
export function siteInputToSiteGeneration(raw: unknown): ToGenerationResult {
  const parsed = SiteInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const v = parsed.data;
  const errors: string[] = [];
  const ref = (r: string | undefined, where: string): string => {
    if (!r) errors.push(`${where}: factRef がない（確認済み事実のキーが必要）`);
    return r ?? "";
  };
  const output: SiteGenerationOutput = {
    schemaVersion: 1,
    company: { name: v.company.name, shortName: v.company.shortName ?? null },
    meta: { title: v.meta.title ?? null, description: v.meta.description },
    theme: { brand: v.theme.brand, accent: v.theme.accent },
    hero: { catchcopy: v.hero.catchcopy, lead: v.hero.lead ?? null },
    sections: v.sections.map((s) => ({ type: s.type, visible: s.visible, heading: s.heading ?? null })),
    services: v.services
      ? {
          intro: v.services.intro ?? null,
          items: v.services.items.map((i) => ({ title: i.title, description: i.description })),
        }
      : null,
    companyInfo: v.companyInfo
      ? {
          intro: v.companyInfo.intro ?? null,
          rows: v.companyInfo.rows.map((r, i) => ({
            label: r.label,
            value: r.value,
            factRef: ref(r.factRef, `companyInfo.rows.${i}`),
          })),
        }
      : null,
    works: v.works
      ? {
          intro: v.works.intro ?? null,
          items: v.works.items.map((w, i) => ({
            title: w.title,
            description: w.description ?? null,
            period: w.period ?? null,
            factRef: ref(w.factRef, `works.items.${i}`),
          })),
        }
      : null,
    contact: {
      phone: v.contact.phone ? { display: v.contact.phone.display, tel: v.contact.phone.tel ?? null } : null,
      email: v.contact.email ?? null,
      hours: v.contact.hours ?? null,
      note: v.contact.note ?? null,
      primary: v.contact.primary,
    },
  };
  return errors.length ? { ok: false, errors } : { ok: true, output };
}
