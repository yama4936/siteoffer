# 顧客管理画面の定義

site-rebuild は、静的サイトと同時に `$OUT/site/admin-schema.json` を作る。SiteOfferの顧客管理画面が、企業ごとに編集できる項目・画像・記事・受付フォームを判別するための契約であり、営業デモ内に管理画面そのものを実装するものではない。管理画面のUI・画面構成・操作体系は全顧客で共通とし、企業別の管理UIを生成しない。

## 原則

- 顧客が編集できるのは、スキーマへ明示した固定項目、記事、画像。レイアウト、ページ構成、CSS、任意HTMLは編集対象にしない
- 編集項目は `content-plan.json.selected_content` の確認済み内容と結び、出典のない空欄を作るために増やさない
- HTMLの表示箇所には `data-siteoffer-field="<id>"`、画像枠には `data-siteoffer-image="<id>"` を付ける。1つの値を複数箇所へ表示する場合は同じIDを使う
- 画像は素材台帳とF-34の権利確認を通す。差し替え欄があるだけで画像利用を許可しない
- 受付フォーム定義は本番接続用。非公式の営業デモでは実際に送信せず、問い合わせを受け付けると報告しない
- 実際の顧客ログイン、DB保存、メール通知、静的サイトの再ビルドを接続・検証するまで `integration_status` は `planned`

## 形式

```json
{
  "schema_version": "0.1",
  "company_ref": "evaluation.json company",
  "integration_status": "planned",
  "editable_fields": [
    {
      "id": "company.business_hours",
      "label": "受付時間",
      "type": "short_text",
      "source_content_ids": ["business-hours"],
      "bindings": [{"page": "contact.html", "section": "お問い合わせ"}],
      "required": false,
      "constraints": {"max_length": 100},
      "help": "曜日・時間・休業日を、確認済みの表記に合わせて入力"
    }
  ],
  "editable_images": [
    {
      "id": "works.main_image",
      "label": "施工事例のメイン画像",
      "source_content_ids": ["work-example-1"],
      "bindings": [{"page": "works.html", "section": "施工事例1"}],
      "required": false,
      "alt_required": true,
      "allowed_uses": ["production"],
      "aspect_ratio": "4:3"
    }
  ],
  "articles": {
    "enabled": true,
    "types": ["news", "blog"],
    "list_placements": [{"page": "news.html", "section": "記事一覧"}],
    "images_allowed": true,
    "migration_required": false
  },
  "inquiry_form": {
    "enabled": true,
    "form_id": "primary-contact",
    "display_page": "contact.html",
    "fields": [
      {"id": "name", "label": "お名前", "type": "text", "required": true},
      {"id": "email", "label": "メールアドレス", "type": "email", "required": true},
      {"id": "message", "label": "お問い合わせ内容", "type": "textarea", "required": true},
      {"id": "privacy_consent", "label": "個人情報の取り扱いに同意する", "type": "consent", "required": true}
    ],
    "store_in_siteoffer": true,
    "customer_inbox": true,
    "email_notification": true,
    "status_management": false,
    "privacy_notice_required": true,
    "spam_controls": ["honeypot", "rate_limit"]
  }
}
```

## 検査条件

- `integration_status` は `planned | connected_verified`。このスキルで定義だけ作った場合は `planned`
- `editable_fields[].id` と `editable_images[].id` は種類をまたいでも重複不可
- 固定項目の `type` は `short_text | long_text | rich_text | phone | email | url | hours | money | list | table`
- 各固定項目は、元になった `selected_content[].id`、表示ページ、入力制約を持つ。`bindings[].page` は実際にそのIDを表示する全ページと一致させる。別ページの同一IDで不足を補わず、繰り返し表示するヘッダー・フッターも列挙する
- 画像は表示ページ、alt必須か、用途、縦横比を持つ。`production` を自動許可する意味ではなく、登録時にその用途の許諾を必要とする指定
- 記事を使う場合は、種別と一覧の表示先を持つ
- 受付フォームは、氏名等の入力欄だけでなく、保存、顧客受信一覧、メール通知、対応状況管理をするか、プライバシー表示、スパム対策を明記する
- 受付項目へ秘密情報・決済情報・本人確認書類を要求しない

`admin-schema.json` は定義であって接続試験の証拠ではない。`connected_verified` は、顧客権限、別企業の拒否、保存、一覧、メール通知、画像許諾、再ビルドまたは配信反映を実際に検証した場合だけ使う。
