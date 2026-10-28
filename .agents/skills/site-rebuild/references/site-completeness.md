# サイトの情報完結性とページ設計

site-rebuild の手順2〜6で使う。ページ数や文字数を増やすこと自体ではなく、訪問者がサイト内の確認済み情報だけで依頼先を判断できる状態を作る。

## 1. 最初に材料の網羅性を確認する

`collected.json` の取得ページだけを完全な元サイトだとみなさない。次を相互に照合する。

- デスクトップ・モバイル画像に見える主メニュー、サブメニュー、バナー、本文中の詳細リンク
- `pages[]` の URL、role、title、headings、text_length、text_excerpt
- `cta_links`、画像のリンク先、フレーム・iframe、クエリ文字列で内容を切り替える旧式サイト
- evaluation / proposal が言及するサービス、実績、会社情報、採用、保証、問い合わせ等

ナビゲーションや評価根拠に存在する主要ページが未取得、本文が空、フレーム内だけ未取得、画像リンク先の事例が未取得なら、薄いデモを作って補わない。HTML生成を止め、追加収集が必要なURLまたはメニュー名を `$OUT/rebuild-blocked.json`（下記）の `missing_sources` に記録する。

URLが分かる未取得ページは、止める前に site-evaluation の collect.py `--add-url` で collected.json へ追記して補ってよい（元サイトの公開ページを、同じ取得条件で1回取るだけ）。追記で揃えば止めずに続ける。追記してもJavaScript描画などで本文が取れないものだけを止める理由にする。

取得済みページに本文がなくても、スクリーンショット上のメニュー名だけを根拠に説明文を創作しない。メニュー名は「不足している情報の手掛かり」であり、完成原稿の根拠ではない。

## 止めたときの記録（rebuild-blocked.json）

取得網羅性や完成原稿の材料が足りずに止めるときは、`$OUT/site/` を作らない（作りかけがあれば削除する）。HTMLのない `site/` や、選定途中の content-plan.json を残さない。代わりに `$OUT/rebuild-blocked.json` を書き、検査する。

```json
{
  "schema_version": "0.1",
  "status": "blocked",
  "stage": "source_coverage",
  "checked_at": "2026-10-28T13:00:00+09:00",
  "collected_ref": {"collector": "site-evaluation/scripts/collect.py 0.2", "pages": 6},
  "missing_sources": [
    {"label": "施工の流れ", "url": "https://example.co.jp/flow", "found_in": "スクリーンショットの主メニュー", "reason": "未取得", "needed_for": ["specifics"]}
  ],
  "blocking_gaps": [
    {"question": "proof", "reason": "実績の区分ページと事例詳細が未取得で、実績を判断できない"}
  ],
  "next_actions": [
    {"action": "collect_add_url", "urls": ["https://example.co.jp/flow"], "command": "python3 .agents/skills/site-evaluation/scripts/collect.py <URL> --out $OUT --add-url https://example.co.jp/flow --reason \"site-rebuild 取得網羅性\""}
  ]
}
```

- `stage` は `source_coverage`（主要ページ・本文の未取得）か `content_readiness`（取得済みだが完成原稿の材料がない）。
- `missing_sources` は1件以上。`label`・`found_in`・`reason` を必須とし、URLが分からないメニューは `url: null`。`needed_for` は2章の判断項目ID。
- `blocking_gaps[].question` は2章の判断項目ID（identity / offer / fit / specifics / proof / trust / action）。
- `next_actions[].action` は `collect_add_url`（collect.py の追記で補えるもの）か `customer_confirmation`（顧客に聞くしかないもの）。`collect_add_url` は `urls` を持つ。
- 追記収集のあとで再実行するときは、`rebuild-blocked.json` を残したまま手順2からやり直し、完成したら削除する。

```bash
python3 <skill>/scripts/check.py --blocked $OUT/rebuild-blocked.json > $OUT/blocked-check.json; echo "exit=$?"
```

## 2. 訪問者の判断を完結させる

`content-plan.json.decision_coverage` で次の問いを1件ずつ判定する。

| ID | 訪問者の問い | 代表的な根拠 |
| --- | --- | --- |
| `identity` | 何の会社か | 正式名称、業種、所在地 |
| `offer` | 何を頼めるか | サービス・商品・業務の具体的説明 |
| `fit` | 自分の依頼が対象か | 対象者、地域、用途、対応範囲、条件 |
| `specifics` | 依頼内容を具体的に想像できるか | 工法、仕様、流れ、料金、保証等の確認済み情報 |
| `proof` | 実行能力を判断できるか | 事例、実績、資格、沿革、設備等の確認済み情報 |
| `trust` | どの会社が責任を持つか | 会社概要、代表、所在地、許認可、連絡先 |
| `action` | 次に何をすればよいか | 電話、メール、確認済み外部窓口 |

各項目の `status` は `answered | not_applicable | missing`。`answered` は `answered_by` に `selected_content[].id` を1件以上持つ。`not_applicable` は企業・業種・サイト目的に照らした理由を持つ。主要な `identity`、`offer`、`trust`、`action`、およびその案件で必要な問いが `missing` なら完成扱いにしない。

情報量は件数で合格にしない。ただしトップの短いコピーと連絡先だけ、サービス名だけ、会社概要の数行だけで `ready_for_customer_review` にしない。元サイトで確認できる有用な詳細を、見た目を簡潔にする目的で削りすぎない。

## 3. シングルページと複数ページを選ぶ

シングルページは、情報が少ない企業、単一サービス、短いキャンペーン、説明の重複が多い場合には使える。既定形にはしない。

次のいずれかなら原則として独立ページにする。

- サービス・商品に、対象、種類、仕様、条件、流れなど独立した説明がある
- 実績・施工例・制作例が複数あり、比較・画像・詳細情報が判断材料になる
- 会社情報に、概要、沿革、理念、資格、拠点などまとまった情報がある
- 年度別実績、料金、仕様、保証など、幅のある表や繰り返しデータがある
- 採用情報の対象読者と主要行動が顧客向け情報と異なる
- お知らせ・ブログを更新機能へ接続する

代表的な4〜6ページ構成は `index.html`、`services.html`、`works.html`、`about.html`、`contact.html` に、根拠があるときだけ `news.html`、`recruit.html` 等を加える形。ただしページ数を満たすために本文を分割しない。1ページだけでも判断が完結すればよく、4〜6ページあっても各ページが見出し数個だけなら不合格。

トップページは全情報の要約置き場ではなく、会社・主要サービス・根拠・主要行動を理解し、各詳細へ進む入口にする。詳細ページにはトップの繰り返しではなく、そのページで判断するための具体情報を置く。

`content-plan.json.site_architecture` に `mode`、案件固有の `reason`、`primary_navigation`、`mobile_content_equivalence_reviewed` を記録する。各ページは `page_plan` に `purpose`、`audience_questions`、`content_ids`、`reason_separate` を記録する。独立させる理由が説明できないページは統合する。具体的な構成・モバイル・リンクの基準は [web-standards.md](web-standards.md) に従う。

複数ページではトップから全HTMLへ通常のリンクで到達でき、各詳細ページからトップへ戻れるようにする。主要ナビゲーションはページ間、PC／スマホ間で同じ語・順序・行き先を保つ。各ページのtitle・description・h1・本文はそのページ固有にし、トップの要約を複製しただけのページは統合する。

## 4. 実績・事例と画像

実績・事例は「社名＋短い説明」のカードを量産せず、出典に応じて名称、年度、場所、発注者、工期、内容、成果、分類など確認できた項目を選ぶ。複数件があるときは年度・カテゴリ・用途等、元データにある軸で整理する。

事例写真は強い判断材料だが、許諾不明の画像を使ったり、生成画像を実績写真として見せたりしない。

- `sales_demo` が確認済みの実画像はローカル保存して使用する
- 生成画像はヒーロー等の雰囲気表現に限定し、施工・商品・人物・施設の証拠にしない
- 写真が事例の理解に不可欠なのに利用可能素材がない場合は `media_plan.missing_essential_assets` に記録する
- 画像なしでも名称・年度・仕様等で判断できる場合は、空枠を置かず情報設計で成立させる

`content-plan.json.media_plan` に、使用可能素材、使用しない素材、必要だが不足する素材、各素材に対応するcontent IDを記録する。

## 5. 表・年度別データ

年度別、区分別、仕様比較など行列の関係が重要な情報は、カードへ崩して関係を失わせずHTMLの`table`を使う。

- 内容を表す `caption` を付ける
- 列見出し・行見出しへ `th` と `scope="col"` / `scope="row"` を使う
- 年度は見出し内に和暦と西暦など、元サイトで確認できた表記を保つ
- 実績と目標、元請と下請など意味の違いを色だけで表さない
- データを年度で分ける場合、年ごとの見出し・タブ・セレクトはJSなしでも全件へ到達できる形にする
- スマホは表全体の横スクロール、先頭列の視認性、スクロール可能である説明を用意する。数値と見出しの対応が崩れるカード変換はしない
- 空値を0、不明を「なし」に変換しない

表の列数や件数を減らして見た目を整えるのではなく、情報を失わず読みやすくする。長い表は年度や意味のある区分で分け、ページ内目次を付ける。

## 6. 更新可能性を設計する

改善デモ自体は静的HTMLであり、編集画面が動くと偽らない。顧客管理画面は全プラン標準で、固定項目、記事、画像、受付フォームをSiteOffer側で扱う。具体的な定義は [admin-schema.md](admin-schema.md) に従い `admin-schema.json` へ出力する。

`content-plan.json.update_plan` を必須にする。

- `mode: "article"`：お知らせ・ブログ・事例記事等、継続更新する根拠がある。`content_types`、一覧・詳細の表示先、既存記事の移行要否、画像要否を記録する
- `mode: "fixed_fields_only"`：継続記事はなく、会社情報・営業時間・サービス・料金・実績・FAQ等の決まった項目と画像だけを編集対象にする。空のお知らせ欄は作らない
- `connection_status` は `planned | connected_verified`。静的デモと定義だけなら `planned` であり「編集できる」と報告しない

レイアウト、ページ構成、デザイン、任意HTMLは編集対象にしない。固定表を編集対象にする場合は列・行・型・上限を定義し、構造自体を自由編集させない。

## 7. 完成判定

次のすべてを満たしたときだけ `ready_for_customer_review` にする。

- `source_coverage.status` が `complete`
- 必須の判断項目に `missing` がない
- `site_architecture.mode` とHTML数が一致し、構成理由・主要ナビゲーション・スマホ情報同等性を確認済み
- `page_plan` の全ページが実在し、各ページに独立した目的と完成文がある
- 表、実績、画像の重要情報を見た目の都合で欠落させていない
- 更新機能の有無と接続状態を正しく記録している
- PC・スマホで、詳細ページまで実際に移動して表示を確認した

完成できないときは、少ない情報で見栄えだけ整えたサイトを成果物にせず、追加収集、素材許諾、顧客確認、更新機能の接続のどれが必要かを返す。
