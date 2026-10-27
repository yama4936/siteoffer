# 企業ごとの掲載情報の選定

site-rebuild の手順3で使う。HTMLを作る前に、取得できた情報からその企業の営業デモへ載せる内容を選び、`$OUT/site/content-plan.json` に確定する。

## 選定基準

情報量を増やすことではなく、訪問者が判断するために必要な問いへ、確認済みの企業固有情報で答えることを優先する。

1. 何の会社で、何を提供しているか
2. 誰・どの地域・どの課題が対象か
3. 依頼先として判断できる具体的な根拠があるか
4. 次に取れる行動と連絡手段は何か

企業ごとに答えられる問いは異なる。確認できない問いを一般論や定番コピーで埋めない。サービス、実績、会社概要、流れ、FAQ、お知らせを必須セクションにしない。

## 情報の判定

掲載候補ごとに次を確認する。

- `relevance`：主要顧客の判断または主要行動に必要か
- `evidence`：collected.json または evaluation.json の具体的な位置と対象URLへ追跡できるか
- `specificity`：別会社にもそのまま使える抽象文ではなく、対象企業についての情報か
- `freshness`：取得日時と本文の日付・期限から、現在も掲載可能と判断できるか
- `rights`：長文転載、画像、ロゴ、人物・実績素材の利用条件を満たすか
- `consistency`：社名、住所、電話、サービス名などが複数箇所で矛盾していないか

`copy_examples`、業界の一般知識、検索結果の抜粋、アシスタントの推測は事実の出典にしない。数値、料金、期間、順位、実績、資格、対応地域、無料表現は、完全な表現単位で根拠と一致させる。

日付付きの情報は、終了が確認できるものを載せない。終了を判断できない古いキャンペーン・採用・イベント・営業時間は `excluded_content` にする。恒常的な会社情報でも、出典同士が矛盾する場合は採用しない。

## 完成文の規則

- 見出しだけで企業名を入れ替えられる汎用コピーにしない。
- 原文の意味、条件、対象、数値、固有名詞を変えずに、短く読みやすく再構成する。
- 出典にない優位性（高品質、安心、地域No.1、豊富な実績、丁寧、最適等）を足さない。
- 「お気軽に」「まずはご相談」など行動を促す短い表現は使えるが、無料・即日・年中無休などの条件を含めない。
- 未確認部分を伏せた結果、不自然または誤解を招く文になるなら項目全体を載せない。
- `【要確認】`、TBD、ダミー、サンプル、準備中、差し替え予定を完成文に含めない。

## content-plan.json

```json
{
  "schema_version": "0.1",
  "company": {
    "name": "株式会社例",
    "source_ref": "evaluation.json company.name"
  },
  "audience_questions": [
    {"question": "何を頼めるか", "answered_by": ["service-inheritance"]},
    {"question": "どう連絡するか", "answered_by": ["primary-phone"]}
  ],
  "selected_content": [
    {
      "id": "service-inheritance",
      "kind": "service",
      "purpose": "主要サービスを最初に理解できるようにする",
      "copy": {
        "heading": "相続登記のご相談",
        "body": "相続登記に関する相談を受け付けています。"
      },
      "placement": [{"page": "index.html", "section": "ファーストビュー"}],
      "source_refs": [
        {"artifact": "collected.json", "path": "pages[role=service].headings", "url": "https://example.jp/service/", "fact": "相続登記"}
      ],
      "selection_reason": "主要サービスとしてトップとサービスページの両方で確認できる",
      "freshness": {"status": "current", "basis": "恒常的なサービス説明。取得時点で終了表記なし"},
      "status": "ready"
    },
    {
      "id": "primary-phone",
      "kind": "contact",
      "purpose": "主要な連絡手段を示す",
      "copy": {"label": "電話で相談する", "display": "00-0000-0000", "href": "tel:0000000000"},
      "placement": [{"page": "index.html", "section": "ヘッダー"}],
      "source_refs": [
        {"artifact": "collected.json", "path": "pages[role=top].tel_links", "url": "https://example.jp/", "fact": "tel:0000000000"}
      ],
      "selection_reason": "トップページで電話窓口として確認できる",
      "freshness": {"status": "current", "basis": "取得時点のトップページに掲載"},
      "status": "ready"
    }
  ],
  "excluded_content": [
    {
      "subject": "春の相談会",
      "reason": "stale_or_unclear",
      "source_refs": [{"artifact": "collected.json", "path": "pages[0].text_excerpt", "url": "https://example.jp/"}],
      "note": "開催年と終了日を確認できないため掲載しない"
    }
  ],
  "review": {
    "visible_claims_traced": true,
    "copy_ready": true,
    "cta_targets_verified": true,
    "reviewed_at": "2026-10-27T12:00:00+09:00"
  }
}
```

### 必須条件

- `selected_content` は1件以上。各項目の `id` は重複させず、`purpose`、空でない `copy`、1件以上の `placement` と `source_refs`、`selection_reason`、`freshness.status`、`status: ready` を持つ。
- `placement[].page` は実在するHTMLファイルと一致させる。
- `source_refs` は成果物内の位置とURLを記録する。URLがない内部成果物の場合だけ `url` を省略できる。
- `freshness.status` は `current | timeless | unclear`。`unclear` の項目は `selected_content` に入れず `excluded_content` へ移す。
- `excluded_content[].reason` は `unverified | stale_or_unclear | rights | irrelevant | duplicate | conflicting` のいずれか。
- `review` の3項目は、実際にHTMLと照合した後だけ `true` にする。1つでも確認できなければサイトを完成扱いにしない。

`content-plan.json` は営業用サイトには配信せず、運営レビューと生成記録に使う。
