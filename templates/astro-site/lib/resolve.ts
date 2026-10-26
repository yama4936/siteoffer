/**
 * 入力の検証・モードの決定・表示用の値の計算。ビルド関数とAstroのページの両方から使う。
 */
import {
  type SectionType,
  type SiteInput,
  SiteInputSchema,
  type SiteMode,
  SiteModeSchema,
} from "../schema/site-input.ts";
import { findMarkers, type MarkerHit } from "./markers.ts";

/** ビルド時にモードを指定する環境変数。 */
export const MODE_ENV = "SITEOFFER_SITE_MODE";
/** ビルド関数がAstroへ解決済みの入力を渡すための環境変数（一時ファイルのパス）。 */
export const RESOLVED_INPUT_ENV = "SITEOFFER_SITE_RESOLVED_INPUT";

/** ビルド関数が書き出し、ページが読む解決済みの入力。 */
export interface ResolvedSite {
  mode: SiteMode;
  input: SiteInput;
}

/**
 * モードの決定。優先順：ビルド関数の引数 > 環境変数 SITEOFFER_SITE_MODE > 入力JSONの mode > demo。
 * 未知の値は例外（黙って demo/delivery に倒さない）。
 */
export function resolveMode(opts: {
  explicit?: string | undefined;
  env?: string | undefined;
  input?: SiteMode;
}): SiteMode {
  for (const [source, v] of [
    ["引数", opts.explicit],
    [MODE_ENV, opts.env],
  ] as const) {
    if (v === undefined || v === "") continue;
    const parsed = SiteModeSchema.safeParse(v);
    if (!parsed.success) throw new Error(`${source} のモード "${v}" は demo / delivery のどちらでもない`);
    return parsed.data;
  }
  return opts.input ?? "demo";
}

export type ValidationResult = { ok: true; input: SiteInput; markers: MarkerHit[] } | { ok: false; errors: string[] };

/** 入力JSON（パース済みのオブジェクト）をZodで検証し、要確認マーカーを数える。 */
export function validateSiteInput(raw: unknown): ValidationResult {
  const parsed = SiteInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { ok: true, input: parsed.data, markers: findMarkers(parsed.data) };
}

/** delivery で要確認マーカーが残っているときのエラー文。 */
export function markerErrorMessage(markers: MarkerHit[]): string {
  const list = markers.map((m) => `  - ${m.path}: ${m.note || "(説明なし)"}`).join("\n");
  return `delivery ビルドに要確認マーカーが ${markers.length} 件残っている。解消してから再ビルドする。\n${list}`;
}

/** 既定の見出し。 */
export const DEFAULT_HEADINGS: Record<SectionType, string> = {
  services: "サービス",
  company: "会社情報",
  works: "実績",
  contact: "お問い合わせ",
};

/** 実際に出力するセクション（表示可否と内容の有無を反映）の順序付きリスト。 */
export function visibleSections(input: SiteInput): { type: SectionType; heading: string; id: string }[] {
  return input.sections
    .filter((s) => s.visible)
    .filter((s) => {
      if (s.type === "services") return !!input.services;
      if (s.type === "company") return !!input.companyInfo;
      if (s.type === "works") return (input.works?.items.length ?? 0) > 0;
      return true;
    })
    .map((s) => ({ type: s.type, heading: s.heading ?? DEFAULT_HEADINGS[s.type], id: s.type }));
}

/** デモ表示の文面。 */
export function demoNoticeText(input: SiteInput): string {
  const name = input.demo?.recipientName ?? input.company.name;
  return `これは${name}様向けの非公式の改善提案デモです。正式なサイトではありません。`;
}

/** tel: に使う番号（数字と+のみ）。 */
export function telHref(phone: { display: string; tel?: string | undefined }): string {
  const raw = phone.tel ?? phone.display;
  return `tel:${raw.replace(/[^0-9+]/g, "")}`;
}

export { contrastRatio, luminance, textColorOn } from "./color.ts";
