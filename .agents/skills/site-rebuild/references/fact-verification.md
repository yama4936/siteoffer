# 表示事実の確認

site-rebuild の手順3と手順8で使う。情報が取得済みであることや元サイトから欠落していないことと、改善後サイトに表示する事実が正しいことは別に確認する。

## 生成前の確認

`content-plan.json.fact_verification` に、表示する事実を一つの意味・条件ごとの claim として記録する。社名・所在地・公式ドメインを先に照合し、同名他社、支店、関連会社の情報を混ぜない。

特に次を分けて確認する。

- 社名、所在地、電話・メール、営業時間、料金
- 資格、受賞、実績数、対象地域、保証、対応条件
- 年度、基準日、開催日、期間限定情報
- title、description、CTA、構造化データに出す企業固有の主張

claim は `source_refs` に成果物内の位置、確認したURL、根拠箇所、確認日時を持つ。元サイト内で表記が矛盾する、期限や現在性を判断できない、文脈が足りない場合は `verified` にしない。検索結果の抜粋や第三者のまとめだけで確定せず、取得済みの企業公式ページを優先する。資格・法人情報等で公的一次情報の再確認が必要なら、このスキルからWebへ再アクセスせず生成を止め、site-evaluation の収集工程で `$OUT` へ根拠を追加してから再開する。

異なる出典の数値、対象、条件、年度を一つのclaimへ結合しない。例えば別ページの「施工120件」と「創業20年」を組み合わせて、新しい実績表現を作らない。原文の主語、否定、例外、単位を保持する。

## claim の形式

```json
{
  "fact_verification": {
    "company_identity_checked": true,
    "claims": [
      {
        "id": "claim-company-name",
        "kind": "identity",
        "statement": "正式名称は株式会社例",
        "content_ids": ["company-name"],
        "source_refs": [
          {
            "artifact": "evaluation.json",
            "path": "company.name",
            "url": "https://example.jp/company/",
            "evidence": "会社概要の商号欄",
            "observed_at": "2026-10-28T12:00:00+09:00"
          }
        ],
        "freshness": {"status": "timeless", "basis": "会社概要の商号欄"},
        "conflicts": [],
        "surfaces": ["body", "title"],
        "source_value": "株式会社例",
        "display_value": "株式会社例",
        "status": "verified"
      }
    ],
    "unresolved_claim_ids": [],
    "reviewed_surfaces": ["body", "title", "description", "cta", "structured_data"],
    "reviewed_at": "2026-10-28T12:30:00+09:00"
  }
}
```

- `kind` は `identity | contact | service | price | credential | achievement | date | condition | other`。
- `content_ids` はclaimを使う `selected_content[].id`。各selected contentは1件以上のclaimと相互に対応させる。
- `status` は `verified | conflicted | stale_or_unknown | needs_confirmation | excluded`。営業用HTMLに使えるのは `verified` だけ。
- `freshness.status` は `current | timeless | unclear`。`unclear` は表示しない。
- `conflicts` は確認した矛盾を記録する。完成時は空にする。正しい表記を判断できなければclaimを除外し、確認事項へ移す。
- `surfaces` は `body | title | description | cta | structured_data`。使う表示面をすべて記録する。
- 電話、金額、件数、年月、資格名など表記変換で取り違えやすい値は `source_value` と `display_value` を記録する。書式を整えても、正規化後の値を変えない。

## 生成後の確認

HTML作成後に全ページを対象として、本文だけでなくtitle、description、CTA、構造化データの企業固有の主張をclaimへ照合する。

1. 表示される企業固有の主張がclaimに追跡できるか確認する。
2. claimの主語、対象、条件、数値、単位、否定、年度、固有名詞が変わっていないか確認する。
3. 別claimの値を結合して、出典にない新しい主張を作っていないか確認する。
4. 未解決claimと未追跡の表示主張を0件にする。
5. 完了後だけ `review.facts_verified: true` と `fact_verification.reviewed_at` を記録する。

`check.py` は台帳の必須項目、claimとselected contentの相互対応、状態・矛盾・鮮度、確認した表示面、重要値の正規化一致を検査する。文脈上の正しさや現実世界での最新性までは自動判定できないため、根拠箇所を実際に読んだ確認を省略しない。
