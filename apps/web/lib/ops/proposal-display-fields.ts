import {
  callScriptSchema,
  faqSchema,
  proposalTextSchema,
  SiteGenerationOutputSchema,
  type VisualDesign,
} from "@siteoffer/schemas";
import { isUuid } from "./form";

export type DisplayField = { key: string; label: string; value: string };
export type DisplayGroup = { id: string; title: string; fields: DisplayField[]; unavailable: boolean };
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const value = (v: string | number | null | undefined) =>
  String(v ?? "")
    .replaceAll("\r\n", "\n")
    .trim();
const field = (key: string, label: string, v: string | number | null | undefined): DisplayField => ({
  key,
  label,
  value: value(v),
});
const list = (items: string[]) => items.map((s, i) => `${i + 1}. ${s}`).join("\n\n");
const sectionNames = { services: "サービス", company: "会社情報", works: "実績", contact: "問い合わせ" };
const terms: Record<string, string> = {
  professional: "信頼感を重視",
  warm: "親しみやすさを重視",
  editorial: "余白と文字を重視",
  bold: "力強さを重視",
  split: "左右に分割",
  centered: "中央に配置",
  statement: "文字を主役に配置",
  continuous: "余白で区切る",
  alternating: "背景を交互に切り替え",
  serif: "明朝系",
  sans: "ゴシック系",
  standard: "標準",
  expressive: "大きく強調",
  surface: "背景の色",
  brand: "メインの色",
  accent: "アクセントの色",
  compact: "コンパクト",
  comfortable: "標準の余白",
  spacious: "広い余白",
  square: "直角・正方形",
  soft: "小さな角丸",
  round: "大きな角丸",
  wide: "広め",
  contained: "左右に余白",
  "edge-to-edge": "左右端まで",
  landscape: "横長",
  portrait: "縦長",
  "image-first": "写真が先",
  "text-first": "文章が先",
  grid: "カード",
  list: "一覧",
  phone: "電話",
  email: "メール",
  high: "高",
  medium: "中",
  low: "低",
  price: "価格",
  scope: "制作範囲",
  process: "進め方",
  domain: "ドメイン",
  trust: "信頼・実績",
  other: "その他",
};
const word = (v: string) => terms[v] ?? v;
const visualLabels = {
  headingFont: "見出しの書体",
  bodyFont: "本文の書体",
  headingScale: "見出しの大きさ",
  background: "ページの背景色",
  surface: "カードなどの背景色",
  text: "本文の色",
  headerTone: "ヘッダーの色",
  buttonTone: "ボタンの色",
  spacing: "余白",
  corners: "角の形",
  contentWidth: "本文の横幅",
  heroTextShare: "最初の画面の文章幅",
  heroFrame: "最初の画面の左右余白",
  heroImageRatio: "メイン写真の縦横比",
  mobileHeroOrder: "スマホの表示順",
  serviceLayout: "サービスの並べ方",
} satisfies Record<keyof VisualDesign, string>;

/** Bound traversal before schema parsing; unknown metadata never becomes a display field. */
export function comparisonInputBounded(raw: unknown) {
  const pending = [raw];
  let nodes = 0,
    characters = 0;
  while (pending.length) {
    if (++nodes > 5000) return false;
    const current = pending.pop();
    if (typeof current === "string") characters += current.length;
    else if (current && typeof current === "object") {
      if (Array.isArray(current) && current.length > 1000) return false;
      const entries = Object.entries(current);
      if (entries.length > 1000 || pending.length + entries.length > 5000) return false;
      for (const [key, item] of entries) {
        characters += key.length;
        pending.push(item);
      }
    }
    if (characters > 262144) return false;
  }
  return true;
}

export function proposalDisplayGroups(raw: unknown): DisplayGroup[] {
  const content = record(raw);
  const result: DisplayGroup[] = [];
  function group(id: string, title: string, fields: DisplayField[] | null) {
    result.push({ id, title, fields: fields ?? [], unavailable: fields === null });
  }
  const site = comparisonInputBounded(content.demoSite) ? SiteGenerationOutputSchema.safeParse(content.demoSite) : null;
  if (site?.success) {
    const s = site.data;
    const fields = [
      field("name", "正式な会社名", s.company.name),
      field("shortName", "表示名", s.company.shortName),
      field("title", "ページタイトル", s.meta.title),
      field("description", "検索向けの説明", s.meta.description),
      field("catchcopy", "メイン見出し", s.hero.catchcopy),
      field("lead", "最初の説明文", s.hero.lead),
      field("brand", "メインの色", s.theme.brand),
      field("accent", "アクセントの色", s.theme.accent),
      field("style", "デザインの方向性", word(s.theme.style)),
      field("heroLayout", "最初の画面の配置", word(s.theme.heroLayout)),
      field("sectionRhythm", "各項目の区切り方", word(s.theme.sectionRhythm)),
      field("visual", "画像からの個別デザイン指定", s.theme.visual ? "あり" : "なし"),
      ...Object.entries(visualLabels).map(([key, label]) => {
        const v = s.theme.visual?.[key as keyof VisualDesign];
        return field(
          `visual.${key}`,
          label,
          v === undefined
            ? null
            : key === "heroTextShare"
              ? `${v}%`
              : v === "square"
                ? key === "corners"
                  ? "直角"
                  : "正方形"
                : word(String(v)),
        );
      }),
      field(
        "sections",
        "項目の順序・表示",
        list(
          s.sections.map(
            (section) =>
              `${sectionNames[section.type]}：${section.visible ? "表示" : "非表示"}${section.heading ? `／${section.heading}` : ""}`,
          ),
        ),
      ),
      field("servicesIntro", "サービスの導入文", s.services?.intro),
      field("services", "サービスの内容", list(s.services?.items.map((i) => `${i.title}\n${i.description}`) ?? [])),
      field("companyIntro", "会社紹介", s.companyInfo?.intro),
      field("companyRows", "会社情報の表", s.companyInfo?.rows.map((r) => `${r.label}：${r.value}`).join("\n")),
      field("worksIntro", "実績の導入文", s.works?.intro),
      field(
        "works",
        "実績の内容",
        list(s.works?.items.map((i) => [i.title, i.period, i.description].filter(Boolean).join("\n")) ?? []),
      ),
      field("phone", "電話番号の表示", s.contact.phone?.display),
      field("tel", "電話リンクの番号", s.contact.phone?.tel),
      field("email", "メール", s.contact.email),
      field("hours", "受付時間", s.contact.hours),
      field("contactNote", "問い合わせの説明", s.contact.note),
      field("primary", "主な問い合わせ方法", word(s.contact.primary)),
    ];
    group("site", "サイトの文章・デザイン設定", fields);
  } else group("site", "サイトの文章・デザイン設定", null);
  const proposal = comparisonInputBounded(content.proposalText)
    ? proposalTextSchema.safeParse(content.proposalText)
    : null;
  group(
    "proposal",
    "改善提案",
    proposal?.success
      ? [
          field("summary", "提案の要点", proposal.data.summary),
          field(
            "measures",
            "改善する内容",
            list(
              proposal.data.measures.map(
                (m) =>
                  `${m.title}（優先度：${word(m.priority)}）\n対象：${m.target.location}${m.target.url ? `／${m.target.url}` : ""}\n現状：${m.current}\n課題：${m.problem}\n改善：${m.improvement}`,
              ),
            ),
          ),
          field("strengths", "残す良い点", list(proposal.data.strengths)),
          field("limitations", "提案の限界・未確認事項", list(proposal.data.limitations)),
        ]
      : null,
  );
  const call = comparisonInputBounded(content.callScript) ? callScriptSchema.safeParse(content.callScript) : null;
  group(
    "call",
    "電話台本",
    call?.success
      ? [
          field("opening", "名乗り・用件", call.data.opening),
          field("sections", "会話の流れ", list(call.data.sections.map((s) => `${s.title}\n${s.lines.join("\n")}`))),
          field("decline", "断られた場合", call.data.onDecline),
          field("closing", "締めの言葉", call.data.closing),
          field("doNotSay", "伝えてはいけない内容", list(call.data.doNotSay)),
        ]
      : null,
  );
  const faq = comparisonInputBounded(content.faq) ? faqSchema.safeParse(content.faq) : null;
  group(
    "faq",
    "想定問答",
    faq?.success
      ? [
          field(
            "items",
            "質問と回答",
            list(faq.data.items.map((i) => `【${word(i.category)}】${i.question}\n${i.answer}`)),
          ),
        ]
      : null,
  );
  return result;
}

/** The client workspace needs only these labels and references, not the raw generation record. */
export function reviewContentSummary(raw: unknown) {
  const content = record(raw),
    proposal = record(content.proposalText),
    revision = record(content.proposalRevision);
  const uuid = (v: unknown) => (typeof v === "string" && isUuid(v) ? v : null);
  const titles = Array.isArray(proposal.measures)
    ? proposal.measures.slice(0, 3).map((m) => {
        const title = record(m).title;
        if (typeof title !== "string") return { title: "" };
        const short = Array.from(title.slice(0, 1000)).slice(0, 500).join("");
        return { title: short + (short.length < title.length ? "…" : "") };
      })
    : [];
  return {
    designVersionId: uuid(content.designVersionId),
    proposalRevision: { sourceVersionId: uuid(revision.sourceVersionId) },
    proposalText: { measures: titles },
  };
}
