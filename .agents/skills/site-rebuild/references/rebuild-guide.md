# 改善後サイトの作り方（rebuild-guide）

site-rebuild の手順2〜6で使う。**そのまま貼らない。** 対象サイトの観測事実と提案書の施策に合わせて、構成・文言・色を決める。

## 目次

1. 材料の読み方（collected.json の項目対応）
2. 掲載内容の前提
3. デザインの引き継ぎ
4. ページ構成の決め方
5. 作り方の規則
6. セクション別の改善パターン（A〜G）
7. ひな形（HTML・CSS）
8. rebuild.json

## 1. 材料の読み方

collected.json は collect.py の出力（`collector` で版を確認する）。**生のHTML・CSSは保存されていない**。0.2 以降はトップの内部リンクを `site.navigation_links_top`（リンク先と文字）に残す。0.1 の出力にはトップの内部リンク一覧もない。色はスクリーンショット、メニューはスクリーンショットとページの role / title から読む。

| 知りたいこと | 見る場所 |
| --- | --- |
| ページの種類 | `pages[].role`（top / company / service / works / contact / price / recruit など）、`url`、`title` |
| 見出し・本文 | `pages[].headings`（h1〜h3、最大60件）、`text_excerpt`（`conditions.text_excerpt_chars` の字数。0.1は3000字、0.2の既定は20000字）。`text_length` で本文量の目安 |
| メニュー | `screenshot-desktop.png` のヘッダー。読み取れなければ role の順（トップ → サービス → 実績 → 料金 → 会社概要 → 採用 → 問い合わせ） |
| 電話・メール | `tel_links`、`mailto_links`、`phone_numbers_in_text`（FAX番号が混ざることがある。text_excerpt の「TEL」「FAX」表記で区別する） |
| 問い合わせ・予約 | `cta_links`、`forms`（action・field_names・field_count）、`iframes` |
| 企業名・所在地 | `evaluation.json` の `company`（name_source / location_source が出典） |
| 画像 | `images.samples`（src・alt・width・height、トップは最大15件）、スクリーンショットでの位置 |
| 目的・想定顧客 | `evaluation.json` の `site_context`（推測であることに注意） |
| 強み | evaluation の items のうちレベル3、evaluation.md の「強み」 |
| 施策 | `proposal.json` の `actions[]` と `issues[]` |

`text_excerpt` は上限の字数で切れている（`text_truncated` で判別。0.1 の出力は3000字）。切れた先の内容を補わない。必要な情報が途中で切れていたら、その内容をHTMLに出さず rebuild.json の確認事項にする。

## 2. 掲載内容の前提

HTMLの構成と文章は `content-plan.json` の `selected_content` から作る。取得できた情報を無差別に網羅するのではなく、対象企業の訪問者が判断するために必要で、出典と鮮度を確認できた内容を十分に選ぶ。詳しい選定基準と形式は [content-selection.md](content-selection.md)、材料の網羅性・ページ分割・表・実績画像・更新可能性は [site-completeness.md](site-completeness.md) に従う。

文章は `source_profile` の固有語・語調・情報の優先順位を引き継ぐ。名称や見出ししか取得できていない項目は名称だけを使い、説明文を生成しない。主要内容の材料が不足する場合は `readiness.status: incomplete` としてサイトを完成扱いにしない。

提案書の `copy_examples` は完成原稿ではない。例文に含まれる事実を `collected.json` または `evaluation.json` で裏付け、企業固有の完成文にできた場合だけ使う。裏付けられない例文、定番のサービス・流れ・FAQ、仮文言は掲載しない。

## 3. デザインの引き継ぎ

目的は「同じ会社のサイトだと分かること」と「改善点が見て分かること」の両立。見た目を全部変えると比較できず、全部残すと改善が伝わらない。

### 残すもの

- **配色**：スクリーンショットから主色（ヘッダー・ロゴ・ボタンの色）、補助色、背景色、文字色を読み、CSS変数にする。
- **雰囲気**：角丸の有無、余白の多さ、写真中心か文字中心か、和風・やわらかい・堅いなどの印象。rebuild.json の `inherited.tone` に一言で書く。
- **ロゴの位置と社名の表記**：左上など元の位置に、社名を文字で置く（画像は使わない）。表記は元サイトのとおり（「株式会社」の有無を含む）。
- **メニューの順番・名称**：分かりにくい名称（例：「Concept」）だけ、提案書に施策があれば日本語に直す。
- **良い点として評価された部分**：構成・文言・情報をそのまま活かす。

### 変えるもの

提案書の施策に加え、可読性、視覚階層、余白、レスポンシブ、デザインの一貫性を成立させるためのシステム変更は行ってよい。元サイトの低品質な装飾や窮屈な構成まで引き継がない。全面的な別ブランド化はせず、何を残し何を変えたかを design-brief.json と rebuild.json に残す。

### 色の調整

元の色が文字のコントラスト不足（G3）の原因なら、色相を保って明度を下げる・上げる。調整したら rebuild.json の `inherited.colors[].adjusted` に元の近似値と理由を書く。

コントラスト比の計算（WCAG の相対輝度。本文 4.5:1 以上、18pt以上または太字14pt以上の大きな文字は 3:1 以上）：

```bash
python3 -c "
import sys
def L(h):
    c=[int(h.lstrip('#')[i:i+2],16)/255 for i in (0,2,4)]
    c=[x/12.92 if x<=0.03928 else ((x+0.055)/1.055)**2.4 for x in c]
    return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
a,b=sorted([L(sys.argv[1]),L(sys.argv[2])]); print(round((b+0.05)/(a+0.05),2))
" '#1a4c8b' '#ffffff'
```

スクリーンショットがない・色が読み取れないときは、紺系（例：#1f3a5f）＋白の中立配色にし、`inherited.colors` に「元サイトの配色：不明」と書く。

## 4. ページ構成の決め方

1. スクリーンショットの主メニュー、評価・提案の言及、collected.json の取得ページを照合する。主要ページやフレーム内本文が欠けていれば追加収集へ戻し、ページ構成を決めない。
2. `content-plan.json.decision_coverage` を完成させ、訪問者の問いに答える情報単位を並べる。
3. collected.json で取得できたページを並べる（role ごと）。
4. 各ページを次のどれかに振り分ける。

| 扱い | 条件 | 例 |
| --- | --- | --- |
| 単独ページで残す | 本文が十分あり（目安：text_length 800字以上）、元サイトでもメニュー項目 | 会社概要、サービス、施工事例 |
| トップのセクションに統合 | 本文が薄い、トップと内容が重なる、提案書で統合を勧めている | 「ご挨拶」だけのページ、料金が数行 |
| 新しく足す | 提案書の施策が求め、確認済みの材料だけで内容を構成できる | 「ご依頼の流れ」「よくある質問」。未確認の回答を並べるだけなら作らない |
| 作らない | 取得していない、サーバー処理が必要、内容がない | ログイン、検索結果、未取得のブログ記事 |

5. 提案書が1ページサイトを前提にしていても、確認済みの詳細を失う場合は複数ページを選び、`actions_not_applied` または構成判断に理由を書く。1ページにまとめるのは情報完結性を保てる場合だけ。
6. 問い合わせ先が確認できたら、`contact.html` を作るか、トップの「お問い合わせ」セクションにする。いずれも中身は電話・メール・外部フォームへのリンクと受付時間（確認できたものだけ）。
7. ファイル名は英小文字の役割名にする：`index.html`、`about.html`（会社概要）、`services.html`、`works.html`、`price.html`、`flow.html`、`faq.html`、`news.html`、`recruit.html`、`contact.html`。元URLとの対応は rebuild.json の `pages[].source_urls`。

ページ数に固定の上下限を置かない。代表的な小規模企業サイトは4〜6ページになり得るが、必要情報が1ページで完結する場合も、6ページを超える場合もある。薄いページを水増しせず、異なる判断目的と十分な詳細があるときだけ分ける。

## 5. 作り方の規則

### ファイル

```
$OUT/site/
  index.html
  about.html …（必要なページだけ）
  assets/style.css
  assets/main.js        … 必要なときだけ
  design-brief.json
  quality-review.json
  admin-schema.json
  rebuild.json
```

### 静的・自己完結

- サーバー処理を作らない。`<form>` は置かない。問い合わせは `tel:`・`mailto:`・元の外部フォームURL（collected.json で確認できたもの）へのリンクにする。
- 外部から読み込まない：CDN の CSS/JS、Webフォント、外部画像、地図・動画の埋め込み（iframe）、計測タグ（Google アナリティクス、タグマネージャー、ピクセル等）。
- 外部への `<a href="https://…">` のリンクは可（元の外部予約サービス・SNS・地図）。`target="_blank"` を付けるなら `rel="noopener"` も付け、「（外部サイト）」と文字で示す。
- フォントはシステムフォント：`font-family: system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", Meiryo, sans-serif;`
- JS は必要最小限。メニュー開閉は `<details>` で作れるなら JS を使わない。JS がなくても全ページ・全連絡手段に辿り着けること。

### パス

- 先頭スラッシュの絶対パス（`/assets/…`、`/about.html`）は禁止。サブパス配信（`/sales/companies/<uuid>/site/`）で壊れるため。
- `about.html`、`assets/style.css` のように相対で書く。トップへは `index.html`（`/` や `./` にしない。file:// でも開けるように）。
- CSS 内の `url()` もCSSファイルからの相対パス。

### 各ページの必須要素

- `<html lang="ja">`
- `<meta charset="utf-8">`、`<meta name="viewport" content="width=device-width, initial-scale=1">`（拡大を禁止しない。`maximum-scale`・`user-scalable=no` を付けない）
- `<title>`：「ページの主題｜地域・業種｜社名」の形でページごとに変える（F1）。地域・業種は確認できたものだけ。
- `<meta name="description">`：80〜120字目安で、そのページの内容を要約。
- `<meta name="robots" content="noindex, nofollow">`：非公式デモを検索に出さない。
- h1 はページの主題を表すテキスト1つ。セクションは h2、その中は h3。階層を飛ばさない。
- 画像に代替テキスト。装飾だけの要素は `aria-hidden="true"`。
- 本文 16px 以上、行間 1.7 程度、ボタンは高さ48px以上・間隔8px以上（D2）。
- 本文のコントラスト 4.5:1 以上（G3）。
- `:focus-visible` で見えるフォーカス枠（outline を消さない）。
- 本文へのスキップリンク（`<a class="skip" href="#main">本文へ移動</a>`）。

### 非公式の明記

- 全ページの最上部に帯：「これは SiteOffer が作成した非公式の改善案（デモ）です。<社名>の公式サイトではありません。」
- フッター：「SiteOfferによる非公式の改善案（デモ）です。正式なサイトではありません」
- 著作権表示（© 社名）は書かない。企業の公式物に見えるため。

### 事実と確認事項

- HTMLに書いてよいのは、collected.json・evaluation.json で確認できた事実（社名・所在地・電話・業務内容の名称・確認済みの強み等）だけ。
- さらに `content-plan.json.selected_content` で `status: ready` とした完成文だけを書く。確認済みでも主要目的に不要、古い可能性、重複、矛盾がある情報は載せない。
- 受付時間・料金・「無料」・対応範囲・実績・資格・お客様の声・スタッフ・FAQの答え・創業年が未確認なら、HTMLの該当行・カード・セクションを省く。
- `【要確認】`、`TBD`、ダミー値をHTMLに表示しない。確認したい内容は rebuild.json の `needs_confirmation` に、対象・関連ページ・質問を書いて残す。
- 電話・メールが確認できないときは、存在しない連絡ボタンを作らない。確認済みの外部フォームがあればそれだけを使い、連絡手段が何もなければ問い合わせセクション自体を省く。

### 画像表現

- 画像1点ごとの出所・権利状態・利用範囲・確認者・確認日時は `image-policy.md` に従って記録する。
- 許諾済みのローカル素材、特定の人物・施設・実績を装わない生成画像、CSS・インラインSVGの抽象表現、画像なしのいずれかを design-brief.json で選ぶ。
- 営業用ファーストビューに「画像予定地」「差し替え予定」などのプレースホルダーを置かない。
- 文字入りの元画像（電話番号画像・見出し画像）は、確認済み内容だけをHTMLテキストに置き換える。
- 元画像の参照URLと許諾確認の必要性は rebuild.json に記録する。未確認素材と元サイトのスクリーンショットは評価参照だけにし、営業デモへ転用しない。

## 6. セクション別の改善パターン

提案書の施策IDに対応するパターン。カテゴリは評価項目（A〜G）。使ったら rebuild.json の `actions_applied[].how` に何をしたか書く。

### A. 問い合わせ導線

- **ヘッダーの連絡ボタン**（A1）：右上に「電話する」（`tel:`）と「お問い合わせ」（contact.html か外部フォーム）。PC では電話番号を文字でも表示。
- **スマホ下部の固定バー**（A1・A2）：幅768px未満で画面下に固定。左「電話」、右「お問い合わせ」。高さ56px以上。`body` の下余白で本文が隠れないようにする。電話番号が確認できないときは電話ボタンを置かない。
- **受付時間を番号の直下に**（A2）：確認できたものだけ。未確認なら表示しない。
- **行動が分かる文言**（A3）：「まずは電話で相談」「見積もりを依頼する」。「無料」は確認できたときだけ。
- **各セクション末尾の導線**（A3）：判断に必要な説明を読んだ直後など、意味のある箇所に置く。同じボタンを段落ごとに反復しない。
- **フォームの置き換え**（A4）：元のフォームの項目を表示用に箇条書きで示し（「お名前・ご連絡先・ご相談内容をお伝えください」）、`mailto:` か元の外部フォームURLへのリンク。自社サーバーのフォームはリンクしない（送信先が元サイトの処理になるため）。

### B. 情報の明確さ

- **ファーストビュー**（B1）：h1 を「業種＋地域＋提供価値」の1文に。確認済みの強みだけをサブコピーに使い、主要な連絡手段があれば直下に置く。プレースホルダー画像は置かない。
- **サービス表現**（B2）：元サイトの業務名と本文を要約する。すべてを同じカードにせず、項目数と関係に応じてリスト、左右分割、段差のあるグリッド等を選ぶ。未確認の期間・料金欄は作らない。
- **ご依頼の流れ・FAQ**（B3）：確認済みの手順・回答がある場合だけ作る。一般論を企業の正式な流れとして表示しない。

### C. 信頼性

- **会社概要の表**（C1）：正式名称・所在地・代表者・設立・事業内容・許認可・連絡先のうち確認できた行だけを表示。地図は外部地図サービスへのリンク（埋め込まない）。
- **実績**（C2）：確認できた事例だけを短く掲載する。許諾済み写真がなければ、画像枠を作らず文章だけで成立させる。お客様の声は掲載許可まで確認できた場合だけ使う。
- **更新情報**（C3）：古いお知らせ・終了したキャンペーンは載せない。日付付きのお知らせ欄は、更新の体制が確認できるまで置かないのを基本にする。

### D. スマホ対応

- 1カラムのレスポンシブ（D1）。ブレークポイントは 768px を基本。
- 表はスマホで横スクロール（`overflow-x: auto` の枠）か、行ごとのカード表示（D1）。年度別・区分別など行列の対応自体が情報なら、カードへ崩さず `caption`、`th scope` を持つ表として保つ。長い表は年度や意味のある区分で分け、元データを削らない。
- 拡大を禁止しない。浮動バッジ・固定要素が本文やボタンに重ならない（D2）。

### E. 表示速度・技術品質

- 静的HTML＋CSS1ファイル＋（必要なら）小さな JS1ファイル。外部読み込みなし（E1）。
- ローカル画像を使う場合は適切な寸法・形式にし、ファーストビュー以外は遅延読み込みを検討する。納品時の画像方針は rebuild.json の `notes` に書く。
- リンク切れなし（E2。check.py で確認）。

### F. 技術的SEO

- ページごとの title・description（F1）、h1 は1つ（F2）。
- sitemap.xml・構造化データ（F3・F4）：デモは noindex なので必須にしない。施策にあれば、LocalBusiness の JSON-LD を確認できた項目だけで `<script type="application/ld+json">` に書く。OGP画像は利用可能なローカル画像がある場合だけ指定する。
- noindex はデモ専用。納品サイトでは外すことを rebuild.json の `notes` に書く。

### G. アクセシビリティ

- 代替テキスト（G1）、`lang="ja"`・ボタンやリンクの文字で行き先が分かる（G2）、コントラストとフォーカス表示（G3）。
- 色だけで情報を伝えない。

## 7. 最低限の構造例

これはデザインのひな形ではなく、必須要素の位置関係を示すだけ。クラス名、レイアウト、セクション表現をそのまま全案件へ流用しない。design-brief.json に合わせて構成する。

### HTML（1ページ分の骨組み）

```html
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>相続・遺言のご相談｜春日井市の司法書士｜<社名></title>
<meta name="description" content="…">
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<a class="skip" href="#main">本文へ移動</a>
<div class="demo-band">これは SiteOffer が作成した非公式の改善案（デモ）です。<社名>の公式サイトではありません。</div>
<header class="site-header">
  <a class="logo" href="index.html"><社名></a>
  <nav aria-label="メインメニュー">
    <ul class="nav"><li><a href="index.html" aria-current="page">トップ</a></li><li><a href="services.html">業務内容</a></li><li><a href="about.html">事務所概要</a></li><li><a href="contact.html">お問い合わせ</a></li></ul>
  </nav>
  <div class="header-cta"><a class="btn btn--tel" href="tel:0000000000">電話する</a><a class="btn" href="contact.html">お問い合わせ</a></div>
</header>
<main id="main">
  <section class="hero">
    <h1>…</h1>
    <p class="lead">…</p>
  </section>
  <section id="service" aria-labelledby="service-h"><h2 id="service-h">…</h2> … </section>
</main>
<footer class="site-footer">
  <p><社名>　<所在地>　TEL <番号></p>
  <p class="demo-note">SiteOfferによる非公式の改善案（デモ）です。正式なサイトではありません。</p>
</footer>
<div class="callbar"><a href="tel:0000000000">電話する</a><a href="contact.html">お問い合わせ</a></div>
</body>
</html>
```

### CSS の要点

```css
:root{--primary:#1f3a5f;--primary-weak:#e6ecf3;--accent:#c0392b;--text:#222;--bg:#fff;--muted:#555}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif;font-size:16px;line-height:1.7;color:var(--text);background:var(--bg)}
a:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:-9999px}.skip:focus{left:8px;top:8px;background:#fff;padding:8px;z-index:100}
.demo-band{background:#333;color:#fff;font-size:14px;padding:6px 16px;text-align:center}
.btn{display:inline-flex;align-items:center;min-height:48px;padding:0 20px;border-radius:6px;background:var(--primary);color:#fff;text-decoration:none;font-weight:bold}
.callbar{display:none}
@media (max-width:767px){
  .header-cta{display:none}
  .callbar{display:grid;grid-template-columns:1fr 1fr;position:fixed;left:0;right:0;bottom:0;z-index:50}
  .callbar a{min-height:56px;display:flex;align-items:center;justify-content:center;color:#fff;background:var(--primary);font-weight:bold;text-decoration:none}
  .callbar a+a{background:var(--accent)}
  body{padding-bottom:56px}
  .table-wrap{overflow-x:auto}
}
```

色は元サイトから読んだ値に置き換え、組み合わせごとにコントラストを確認する。

## 8. rebuild.json

```json
{
  "schema_version": "0.1",
  "created_at": "2026-10-14T17:00:00+09:00",
  "generator": {"skill": "site-rebuild", "model": "確認できたモデルID、なければ「不明」"},
  "source": {
    "url": "https://example.co.jp/",
    "evaluation_ref": "../evaluation.json",
    "proposal_ref": "../proposal.json",
    "proposal_version": 1,
    "scope_ref": "../rebuild-scope.json"
  },
  "company": {"name": "株式会社例", "name_source": "evaluation.json company.name_source"},
  "content_plan_ref": "content-plan.json",
  "content_selection": {"selected_count": 8, "excluded_count": 3, "visible_claims_traced": true},
  "demo_notice": "SiteOfferによる非公式の改善案（デモ）です。正式なサイトではありません。",
  "pages": [
    {"file": "index.html", "title": "…", "role": "top", "source_urls": ["https://example.co.jp/"], "sections": ["ファーストビュー", "業務内容", "ご依頼の流れ", "お問い合わせ"]}
  ],
  "pages_not_rebuilt": [{"source_url": "https://example.co.jp/blog/", "reason": "未取得のため作らない"}],
  "actions_applied": [
    {"action_id": "P-01", "title": "ヘッダーとスマホ下部に連絡ボタンを常設する", "pages": ["index.html", "about.html"], "how": "ヘッダー右上に電話・問い合わせボタン、768px未満で下部固定バー"}
  ],
  "actions_not_applied": [{"action_id": "P-07", "reason": "企業固有画像の利用許諾が未確認のため、抽象表現で構成"}],
  "inherited": {
    "colors": [{"role": "primary", "value": "#1a4c8b", "source": "screenshot-desktop.png ヘッダー背景", "approximate": true, "adjusted": null}],
    "logo": {"treatment": "text", "text": "株式会社例", "source": "evaluation.json company.name", "note": "元ロゴ画像は利用許諾未確認のため使わない"},
    "navigation": [{"label": "会社概要", "file": "about.html", "source": "screenshot-desktop.png ヘッダーメニュー"}],
    "content": [{"what": "業務内容の名称（相続登記・遺言書作成）", "source_url": "https://example.co.jp/service.html", "verbatim": true}],
    "tone": "白地に紺、写真少なめの堅い印象"
  },
  "images": [
    {
      "id": "hero-exterior",
      "page": "index.html",
      "label": "元サイトの事務所外観写真",
      "source_type": "original_site",
      "source_ref": "https://example.co.jp/img/main.jpg",
      "rights_status": "unknown",
      "allowed_uses": ["analysis_only"],
      "confirmed_by": null,
      "confirmed_at": null,
      "treatment": "abstract",
      "note": "営業デモでは事務所を表さない抽象表現に変更"
    }
  ],
  "excluded_features": ["問い合わせフォームの送信（mailto: リンクに置き換え）"],
  "needs_confirmation": [
    {"subject": "受付時間", "related_pages": ["index.html", "contact.html"], "ask": "電話の受付時間・定休日。確認前はHTMLに表示しない"}
  ],
  "check": {"ok": true, "errors": 0, "warnings": 0, "quality_status": "pass", "quality_score": 88, "notes": ["…"]},
  "notes": ["デモ用に noindex を付けている。納品サイトでは外す"]
}
```

- `actions_applied[].action_id` は proposal.json の `actions[].id` と一致させる。全施策が `actions_applied` か `actions_not_applied` のどちらかに入ること。
- `content_selection` の件数は content-plan.json と一致させる。`visible_claims_traced` は全HTMLの表示内容を照合してから true にする。
- `needs_confirmation` は営業用HTMLから省いた未確認事項を対象ごとにまとめる。関連するページと、企業へ聞く内容を書く。確認事項があること自体はデモの不合格ではなく、画面に内部注記を露出することが不合格。
