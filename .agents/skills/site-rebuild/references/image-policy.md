# 画像素材の権利・利用範囲

画像は1点ごとに出所、権利状態、利用範囲、確認者、確認日時を記録する。サイト単位の一括許可や「非公開デモだから可」という推定はしない。

## 利用段階

| 段階 | 条件 | 扱い |
| --- | --- | --- |
| 評価参照のみ | `rights_status: unknown` | 内容・配置の分析にだけ使う。営業デモや納品サイトのHTML・CSSから読み込まない |
| 営業デモ可 | `allowed_uses` に `sales_demo` があり、確認者・確認日時がある | ローカルへ保存した素材だけを、有効期限・閲覧制限・取り消しを持つ非公式デモで使う。ホットリンクしない |
| 本番利用可 | `allowed_uses` に `production` があり、確認者・確認日時がある | 原則として顧客から提供された元データを納品サイトで使う。営業デモの許可を本番許可とみなさない |

`rights_status` は次のいずれか。

- `unknown`：権利・利用許諾を確認していない
- `customer_claimed`：顧客が権利を持つ、または利用可能だと申告した
- `license_verified`：素材ライセンスと対象用途を確認した
- `use_approved`：権利者または権限のある顧客から対象用途の許諾を確認した

## rebuild.json の画像記録

```json
{
  "id": "hero-exterior",
  "label": "トップページの店舗外観",
  "source_type": "original_site",
  "source_ref": "https://example.jp/assets/exterior.jpg",
  "rights_status": "unknown",
  "allowed_uses": ["analysis_only"],
  "confirmed_by": null,
  "confirmed_at": null,
  "treatment": "abstract",
  "note": "外観写真の許諾未確認。営業デモでは建物を表さない抽象表現に変更"
}
```

- `source_type`：`original_site | customer_upload | generated | operator_upload`
- `allowed_uses`：`analysis_only | sales_demo | production`。重複させない
- `rights_status: unknown` の場合、`allowed_uses` は `analysis_only` だけにする
- `sales_demo` または `production` を含める場合、`confirmed_by` と `confirmed_at` を必須にする
- 元サイトのスクリーンショットは内部の評価証拠であり、常に `analysis_only`。改善後サイトの素材として切り出さない

## 企業固有画像

ロゴ、スタッフ、店舗・事務所外観、施工・制作実績、商品、お客様の声に紐づく人物写真は個別に許諾を確認する。許諾がなければ次の順で扱う。

1. 事実を装わないCSS・インラインSVG・幾何学模様で構成する
2. 特定の人物、施設、商品、実績ではない雰囲気画像を生成する
3. 写真が証拠になる施工例・商品・お客様の声は画像を捏造せず、セクション自体を省く
4. ロゴは社名のテキストで表す

営業用ファーストビューに空の枠、「画像予定地」、「差し替え予定」を置かない。
