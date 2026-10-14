/**
 * 生成サイト（1ページの企業サイト）の入力JSON（site.json）の形。
 *
 * - テンプレートはこの入力だけを読んでページを組み立てる。内容・構成（セクションの順序と表示可否）・色を差し替える。
 * - 後でT5の生成スキーマ（packages/schemas/src/generation/）と統合する予定。型名とフィールドの意味をここで定める。
 * - 文字列には要確認マーカー `{{要確認:説明}}` を入れてよい（未確認の事実を仮置きする印。lib/markers.ts）。
 *   demoでは目立つ表示で残し、deliveryではビルドを失敗させる。
 */
import { z } from "zod";

/** セクションの種類。ファーストビュー（hero）は常に先頭に出すので含めない。 */
export const SectionTypeSchema = z.enum(["services", "company", "works", "contact"]);
export type SectionType = z.infer<typeof SectionTypeSchema>;

/** ビルドのモード。demo＝提案用（非公式表示・noindex）、delivery＝納品用（表示なし・要確認の残存を許さない）。 */
export const SiteModeSchema = z.enum(["demo", "delivery"]);
export type SiteMode = z.infer<typeof SiteModeSchema>;

/** 色。`#rrggbb` の16進のみ（CSS注入を避けるため任意の文字列は受け付けない）。 */
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "色は #rrggbb の形式で指定する");

/**
 * 画像。src は入力JSONのあるディレクトリからの相対パス（ビルド時に出力の /images/ へコピーする）。
 * 外部URL（http/https）は外部読み込みになるので受け付けない。alt は必須（装飾目的でも説明を書く）。
 */
export const SiteImageSchema = z.object({
  /** 入力JSONからの相対パス。`..` で入力ディレクトリの外を指すことは不可。 */
  src: z
    .string()
    .min(1)
    .refine((v) => !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith("/") && !v.startsWith("\\"), {
      message: "画像は入力JSONからの相対パスで指定する（URL・絶対パスは不可）",
    })
    .refine((v) => !v.split(/[\\/]/).includes(".."), { message: "画像のパスに .. は使えない" }),
  /** 代替テキスト。画像の内容・役割を書く。 */
  alt: z.string().trim().min(1, "alt は必須"),
});
export type SiteImage = z.infer<typeof SiteImageSchema>;

/** 構成：セクション1つ分の配置。配列の順に表示する。 */
export const SiteSectionSchema = z.object({
  /** セクションの種類。 */
  type: SectionTypeSchema,
  /** false なら出力しない（ナビゲーションにも出さない）。 */
  visible: z.boolean().default(true),
  /** 見出しの差し替え。省略時は既定の見出し（サービス・会社情報・実績・お問い合わせ）。 */
  heading: z.string().min(1).optional(),
});
export type SiteSection = z.infer<typeof SiteSectionSchema>;

/** 電話の問い合わせ先。 */
export const PhoneContactSchema = z.object({
  /** 画面に出す表記（例：03-0000-0000）。 */
  display: z.string().min(1),
  /** tel: リンクに使う番号。省略時は display から数字と + だけを取り出す。 */
  tel: z.string().optional(),
});

export const SiteInputSchema = z
  .object({
    /** 入力形式の版。形を変えたら上げる。 */
    schemaVersion: z.literal(1),
    /** モード。省略時はビルド時の指定（環境変数 SITEOFFER_SITE_MODE / ビルド関数の引数）、それもなければ demo。 */
    mode: SiteModeSchema.optional(),
    /** html の lang 属性。 */
    lang: z.string().default("ja"),
    /** 企業の基本情報。 */
    company: z.object({
      /** 会社名（正式名称）。ページの見出し・デモ表示の宛名に使う。 */
      name: z.string().min(1),
      /** 短い社名・屋号（ヘッダーのロゴ文字に使う。省略時は name）。 */
      shortName: z.string().min(1).optional(),
      /** ロゴ画像（任意）。 */
      logo: SiteImageSchema.optional(),
    }),
    /** ページの title と meta description。 */
    meta: z.object({
      /** title 要素。省略時は「会社名 | キャッチ」。 */
      title: z.string().min(1).optional(),
      /** meta description。 */
      description: z.string().min(1),
    }),
    /** 色。brand＝ヘッダー・見出し帯などの基調色、accent＝ボタン・強調の色。文字色はコントラストから自動で決める。 */
    theme: z.object({
      brand: HexColorSchema,
      accent: HexColorSchema,
    }),
    /** ファーストビュー。会社名・キャッチ・主な問い合わせ手段（contact.primary）のボタンを出す。 */
    hero: z.object({
      /** キャッチコピー（1文）。 */
      catchcopy: z.string().min(1),
      /** キャッチの補足文。 */
      lead: z.string().min(1).optional(),
      /** メイン画像（任意）。 */
      image: SiteImageSchema.optional(),
    }),
    /** 構成：hero の後に並べるセクションの順序と表示可否。各種類は1回まで。 */
    sections: z.array(SiteSectionSchema).min(1),
    /** サービス（事業内容）。 */
    services: z
      .object({
        intro: z.string().min(1).optional(),
        items: z
          .array(
            z.object({
              title: z.string().min(1),
              description: z.string().min(1),
              image: SiteImageSchema.optional(),
            }),
          )
          .min(1),
      })
      .optional(),
    /** 会社情報。表（項目名と値）で出す。例：所在地・代表者・設立・事業内容。 */
    companyInfo: z
      .object({
        intro: z.string().min(1).optional(),
        rows: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).min(1),
      })
      .optional(),
    /** 実績。確認済みのものだけを入れる（未確認なら要確認マーカーを付けるか載せない）。空ならセクションを出さない。 */
    works: z
      .object({
        intro: z.string().min(1).optional(),
        items: z.array(
          z.object({
            title: z.string().min(1),
            description: z.string().min(1).optional(),
            /** 年・時期の表記（例：2025年）。 */
            period: z.string().min(1).optional(),
            image: SiteImageSchema.optional(),
          }),
        ),
      })
      .optional(),
    /** 問い合わせ先。電話・メールのリンクのみ（フォームは作らない）。 */
    contact: z.object({
      phone: PhoneContactSchema.optional(),
      email: z.string().min(1).optional(),
      /** 受付時間などの補足。 */
      hours: z.string().min(1).optional(),
      /** その他の注記。 */
      note: z.string().min(1).optional(),
      /** ファーストビューに出す主な問い合わせ手段。 */
      primary: z.enum(["phone", "email"]),
    }),
    /** デモ表示の宛名（「〇〇様向け」）。省略時は company.name。 */
    demo: z.object({ recipientName: z.string().min(1).optional() }).optional(),
    /** フッターの著作権表記の名義。省略時は company.name。 */
    footer: z.object({ copyright: z.string().min(1).optional() }).optional(),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.sections.forEach((s, i) => {
      if (seen.has(s.type)) {
        ctx.addIssue({ code: "custom", path: ["sections", i, "type"], message: `セクション ${s.type} が重複している` });
      }
      seen.add(s.type);
      if (!s.visible) return;
      if (s.type === "services" && !v.services) {
        ctx.addIssue({ code: "custom", path: ["services"], message: "services を表示するなら内容が必要" });
      }
      if (s.type === "company" && !v.companyInfo) {
        ctx.addIssue({ code: "custom", path: ["companyInfo"], message: "company を表示するなら companyInfo が必要" });
      }
    });
    const c = v.contact;
    if (!c.phone && !c.email) {
      ctx.addIssue({ code: "custom", path: ["contact"], message: "電話かメールのどちらかが必要" });
    }
    if (c.primary === "phone" && !c.phone) {
      ctx.addIssue({ code: "custom", path: ["contact", "primary"], message: "primary が phone なのに電話がない" });
    }
    if (c.primary === "email" && !c.email) {
      ctx.addIssue({ code: "custom", path: ["contact", "primary"], message: "primary が email なのにメールがない" });
    }
  });

/** 入力JSON（パース前の形）。 */
export type SiteInputRaw = z.input<typeof SiteInputSchema>;
/** 検証・既定値適用後の入力。 */
export type SiteInput = z.output<typeof SiteInputSchema>;
