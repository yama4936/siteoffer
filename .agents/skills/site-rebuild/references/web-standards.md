# 会社サイトの構成・モバイル・検索の根拠

site-rebuild の手順4〜8で、単一ページ／複数ページ、ナビゲーション、モバイル表示、公開時の技術要件を決めるときに使う。ここにあるのはページ数のノルマではなく、公式文書から SiteOffer の静的な会社サイトへ適用する判断基準である。

## 1. SiteOfferで採用する判断

- **単一ページを既定にしない。** サービス、実績、会社情報、料金・仕様、採用、記事などに固有の目的と十分な完成文がある場合は、それぞれ固有URLを持つページにする。トップは会社・主要サービス・信頼材料・主要行動を示し、詳細への入口を担う。
- **ページ数をSEOの代理指標にしない。** 固有の目的や本文がない薄いページは作らず、同じ要約を複数URLへ複製しない。単一ページは、単一サービスや短いキャンペーンなど、情報を失わず判断が完結するときだけ選ぶ。
- **各ページを独立した到着先として作る。** 固有の `title`、meta description、h1、目的、本文、主要行動を持たせる。リンク文は「詳しく」だけにせず、リンク先の内容が分かる語にする。
- **HTMLのリンクで到達可能にする。** トップから全ページへ標準の `<a href>` で辿れるようにし、各詳細ページからトップへ戻れるようにする。主要ページはトップの本文導線か主要ナビゲーションの少なくとも一方に置く。
- **複数ページのナビゲーションを一貫させる。** PCとスマホで、表示する項目の語・順序・行き先を変えない。現在地は `aria-current="page"` 等で示す。小規模サイトではトップの主要リンク群がサイトマップの役割を兼ねてよい。
- **スマホで情報を削らない。** PCと同じ主要本文、見出し、画像の説明、内部リンクを保持する。折りたたみは使えるが、操作しないとDOMへ現れない方式で主要情報を遅延生成しない。
- **レスポンシブは縮小版にしない。** viewportを設定し、320 CSS px相当でも通常コンテンツに二方向スクロールを要求しない。表など二次元配置が意味に必要なものだけ、説明付きの横スクロールを許す。
- **操作対象と固定要素を検査する。** 重要なボタンは少なくとも24×24 CSS pxを満たし、実務上は押しやすい余白も持たせる。固定ヘッダー・スマホ下部CTAは、Tab移動時の要素やページ内リンクの到着位置を完全に隠さない。`scroll-padding` / `scroll-margin` と本文の上下余白を設計する。
- **画像と速度を両立する。** 幅・高さを持たせ、画面幅に合う画像を使う。ファーストビューの主要画像を `loading="lazy"` にしない。主要画像以外は必要に応じて遅延読み込みし、PC・スマホの実画面と測定結果で確かめる。
- **公開時だけ検索向け出力を有効にする。** 営業デモは従来どおり `noindex, nofollow`。納品公開時は noindex を外し、固有URL、canonical、sitemap、クロール可能な内部リンク、各ページ固有のtitle・descriptionを検査する。Organization / LocalBusiness は確認済み事実だけを、トップまたは会社情報ページへ置く。

## 2. content-plan.jsonへ残す

`site_architecture` を必須にする。

```json
{
  "site_architecture": {
    "mode": "multi_page",
    "reason": "サービス詳細と会社情報がそれぞれ独立した判断材料を持つ",
    "primary_navigation": ["index.html", "services.html", "about.html", "contact.html"],
    "mobile_content_equivalence_reviewed": true
  }
}
```

- `mode` は `single_page | multi_page`。HTMLが1件ならsingle、2件以上ならmultiと一致させる。
- `reason` は案件の確認済み情報に基づく。SEOに有利そう、4ページ欲しい、テンプレートがそうなっている、だけを理由にしない。
- `primary_navigation` は主要ナビゲーションへ出す実在HTML。すべての下層を並べる必要はないが、トップを含める。全HTMLはトップからリンクで到達できるようにする。
- `mobile_content_equivalence_reviewed` は、PCとスマホで主要情報・主要リンクを欠落させていないことを実画面で確認した後だけtrueにする。
- `single_page` の場合、`reason` に独立ページへ分けるだけの固有本文がないことと、7つの判断項目を省略せず完結できることを書く。

## 3. 実画面レビュー

PC 1440px前後、スマホ390px前後に加え、必要に応じて320pxでも確認する。

- トップから作成した全ページへ実際に移動でき、詳細からトップへ戻れる
- 現在地、メニューの語・順序・行き先がページ間と画面幅間で一貫する
- スマホで主要本文・主要リンク・画像の説明が消えていない
- 固定ヘッダー／下部CTAが、ページ内リンクの見出し、入力、フォーカス表示を隠さない
- タッチ対象が小さすぎず、隣接する操作を誤って押しにくい
- 各ページのtitle、description、h1、本文がそのページ固有で、トップの複製になっていない
- 主要画像の表示でレイアウトが動かず、ファーストビュー画像を遅延読み込みしていない

## 4. 参照した公式資料

実装時に仕様や数値を再確認する場合の一次資料。取得確認日は2026-10-28。

- Google Search Central, SEO Starter Guide — 論理的なサイト構造、説明的URL、ページ固有のtitle・description、重複回避
  - https://developers.google.com/search/docs/fundamentals/seo-starter-guide
- Google Search Central, Link best practices — クロール可能な `<a href>` と説明的なアンカーテキスト
  - https://developers.google.com/search/docs/crawling-indexing/links-crawlable
- Google Search Central, Mobile-first indexing — PCとスマホの主要本文・見出し・画像説明・リンクを同等にする
  - https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing
- Google Search Central, Organization structured data — トップまたは会社情報ページへ確認済みの組織情報を置く
  - https://developers.google.com/search/docs/appearance/structured-data/organization
- web.dev, Responsive web design basics — viewport、横スクロール回避、可変画像
  - https://web.dev/articles/responsive-web-design-basics
- web.dev, Core Web Vitals thresholds / Optimize LCP — LCP・INP・CLSの基準、主要画像の優先読み込み
  - https://web.dev/articles/defining-core-web-vitals-thresholds
  - https://web.dev/articles/optimize-lcp
- W3C WAI, WCAG 2.2 — Reflow、Focus Not Obscured、Target Size、Multiple Ways、Consistent Navigation
  - https://www.w3.org/TR/WCAG22/
- W3C WAI, Menu Structure — セマンティックなナビゲーション、現在地、画面幅間の一貫性
  - https://www.w3.org/WAI/tutorials/menus/structure/
- GOV.UK Design System, Help users to navigate a service — 主要なトップレベルだけをナビゲーションへ置き、ナビゲーションをサイトマップにしない
  - https://design-system.service.gov.uk/patterns/navigate-a-service/
