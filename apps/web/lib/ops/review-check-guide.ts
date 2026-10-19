import type { ReviewCheckKey } from "./review-draft-types";

export function reviewCheckGuide(key: ReviewCheckKey, hasDesign: boolean) {
  const guides = {
    company: {
      tab: "assets",
      title: "会社情報を照合する",
      description:
        "下の企業情報と、制作サイトに表示された会社名・住所・電話番号が一致するか確認してください。修正が必要な情報は、企業情報・素材の編集へ進めます。",
      requiresPreview: false,
    },
    rights: {
      tab: "assets",
      title: "使う画像と利用範囲を確認する",
      description:
        "制作サイトで使用する写真・ロゴを、下の画像素材・利用許諾と照合してください。許可は営業デモ用か、本番掲載用かも確認し、不明な点は確認メモへ残してください。",
      requiresPreview: false,
    },
    devices: {
      tab: hasDesign ? "design" : "compare",
      title: "PC・スマホ両方の見え方を確認する",
      description:
        "上のPC・スマホ切り替えで、制作サイトの文字・余白・写真・メニューの読みやすさを確認してください。制作元の画像がある場合は、承認した方向性との違いも見比べてください。",
      requiresPreview: true,
    },
    links: {
      tab: "compare",
      title: "リンクと問い合わせ先を確認する",
      description:
        "改善案のメニュー・電話・問い合わせ先が、確認した会社情報と一致するか確認してください。プレビューで動かせないフォーム送信や外部連携は、合意したテスト環境で確認し、未確認のままチェックを付けないでください。",
      requiresPreview: true,
    },
    continuity: {
      tab: "proposal",
      title: "既存の機能と引き継ぐ範囲を確認する",
      description:
        "下の提案資料で、ブログ・お知らせ・フォームなどの既存機能と、記事・画像の移行範囲を確認してください。資料の記載だけでは動作確認にならないため、未検証の機能や移行条件は確認メモへ残してください。",
      requiresPreview: false,
    },
  } as const;
  return guides[key];
}
