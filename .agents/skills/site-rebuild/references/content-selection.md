# 企業ごとの掲載情報の選定

site-rebuild の手順3で使う。HTMLを作る前に、取得できた情報からその企業の営業デモへ載せる内容を選び、`$OUT/site/content-plan.json` に確定する。

## 選定基準

情報量を増やすことではなく、訪問者が判断するために必要な問いへ、確認済みの企業固有情報で答えることを優先する。

1. 何の会社で、何を提供しているか
2. 誰・どの地域・どの課題が対象か
3. 依頼先として判断できる具体的な根拠があるか
4. 次に取れる行動と連絡手段は何か

企業ごとに答えられる問いは異なる。確認できない問いを一般論や定番コピーで埋めない。サービス、実績、会社概要、流れ、FAQ、お知らせを必須セクションにしない。

最初に元サイトの `source_profile` を作る。繰り返されるサービス名、企業固有の呼称、対象、地域、条件、文章の調子、元サイトが先に伝えている内容を記録し、完成文の語彙と優先順位に反映する。

## 情報の判定

掲載候補ごとに次を確認する。

- `relevance`：主要顧客の判断または主要行動に必要か
- `evidence`：collected.json または evaluation.json の具体的な位置と対象URLへ追跡できるか
- `specificity`：別会社にもそのまま使える抽象文ではなく、対象企業についての情報か
- `business_relevance`：企業の顧客が商品・サービス・会社・利用条件・実績・連絡方法を判断するための情報か
- `freshness`：取得日時と本文の日付・期限から、現在も掲載可能と判断できるか
- `rights`：長文転載、画像、ロゴ、人物・実績素材の利用条件を満たすか
- `consistency`：社名、住所、電話、サービス名などが複数箇所で矛盾していないか

`copy_examples`、業界の一般知識、検索結果の抜粋、アシスタントの推測は事実の出典にしない。数値、料金、期間、順位、実績、資格、対応地域、無料表現は、完全な表現単位で根拠と一致させる。

日付付きの情報は、終了が確認できるものを載せない。終了を判断できない古いキャンペーン・採用・イベント・営業時間は `excluded_content` にする。恒常的な会社情報でも、出典同士が矛盾する場合は採用しない。

## 完成文の規則

- 見出しだけで企業名を入れ替えられる汎用コピーにしない。
- 原文の意味、条件、対象、数値、固有名詞を変えずに、短く読みやすく再構成する。
- 元サイトで使われている企業固有のサービス名・呼称を、一般的な別表現へ勝手に置き換えない。
- 元サイトの短い事実や名称は正確に保持する。本文は要約・統合・重複削除を行ってよいが、主語、対象、条件、程度を変えない。
- 出典にない優位性（高品質、安心、地域No.1、豊富な実績、丁寧、最適等）を足さない。
- 「お気軽に」「まずはご相談」など行動を促す短い表現は使えるが、無料・即日・年中無休などの条件を含めない。
- 未確認部分を伏せた結果、不自然または誤解を招く文になるなら項目全体を載せない。
- `【要確認】`、TBD、ダミー、サンプル、準備中、差し替え予定を完成文に含めない。
- 制作過程や改善施策を説明しない。「現在のサイトを整理した」「スマホで見やすくした」「画像メニューをテキスト化した」「読み上げに対応した」「情報設計を改善した」「余白や見出しを整えた」などは、企業の業務内容ではない。
- デザインのモチーフ、画像を使わない理由、抽象表現であることを本文に注釈しない。これらは design-brief.json と rebuild.json にだけ記録する。
- ページやサイト自体を主語にした自己解説を避ける。本文は企業、商品・サービス、利用者が判断する内容を主語にする。

迷ったときは、その文を元の企業サイトへそのまま掲載しても顧客に意味があるかで判断する。制作会社から企業への作業報告にしかならない文は `excluded_content` の `irrelevant` とし、営業用HTMLへ出さない。

メニュー名しか取得できない場合、名称はナビゲーションや一覧に使えるが、説明本文の根拠にはしない。たとえば「施工例紹介」から「豊富な施工実績をご紹介します」と補わず、「施工例紹介」という名称だけを使う。主要サービスの説明がこの状態しかないなら、完成扱いにせず追加取得または顧客確認を必要とする。

## content-plan.json

```json
{
  "schema_version": "0.1",
  "company": {
    "name": "株式会社例",
    "source_ref": "evaluation.json company.name"
  },
  "source_profile": {
    "distinctive_terms": ["相続登記", "遺言書作成"],
    "tone": "専門用語を保ちつつ簡潔な敬体",
    "content_priorities": ["取扱業務", "相談方法", "事務所情報"],
    "source_refs": [{"artifact": "collected.json", "path": "pages[role=service]", "url": "https://example.jp/service/"}]
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
      "source_fidelity": {
        "mode": "faithful_rewrite",
        "preserved_terms": ["相続登記"],
        "meaning_preserved": true,
        "editorial_changes": "重複を除き、相談受付の一文に短縮"
      },
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
      "source_fidelity": {
        "mode": "verbatim_fact",
        "preserved_terms": ["00-0000-0000"],
        "meaning_preserved": true,
        "editorial_changes": "表示用のハイフンを保ち、hrefだけ数字へ正規化"
      },
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
    "source_fidelity_reviewed": true,
    "presentation_ready": true,
    "reviewed_at": "2026-10-27T12:00:00+09:00"
  },
  "readiness": {
    "status": "ready_for_customer_review",
    "blocking_gaps": [],
    "production_blockers": ["顧客による文章確認", "画像利用許諾", "本番フォーム接続"]
  }
}
```

### 必須条件

- `source_profile` は空でない固有語、語調、情報の優先順位、出典を持つ。
- `selected_content` は1件以上。各項目の `id` は重複させず、`purpose`、空でない `copy`、1件以上の `placement` と `source_refs`、`selection_reason`、`source_fidelity`、`freshness.status`、`status: ready` を持つ。
- `source_fidelity.mode` は `verbatim_fact | faithful_rewrite | structural_label`。保持した語を `preserved_terms` に記録し、意味を照合したときだけ `meaning_preserved: true` にする。`editorial_changes` には省略・統合・言い換えの内容を書く。
- `placement[].page` は実在するHTMLファイルと一致させる。
- `source_refs` は成果物内の位置とURLを記録する。URLがない内部成果物の場合だけ `url` を省略できる。
- `freshness.status` は `current | timeless | unclear`。`unclear` の項目は `selected_content` に入れず `excluded_content` へ移す。
- `excluded_content[].reason` は `unverified | stale_or_unclear | rights | irrelevant | duplicate | conflicting` のいずれか。
- `review` の5項目は、実際にHTMLと元サイト由来の材料を照合した後だけ `true` にする。1つでも確認できなければサイトを完成扱いにしない。
- `readiness.status` は `ready_for_customer_review | incomplete`。主要サービスの説明、企業識別、主要行動に必要な文章を元サイトから作れない場合は `incomplete` とし、`blocking_gaps` に不足を記録してHTML生成・DB取り込みを止める。
- `ready_for_customer_review` は顧客へ見せられる文章品質を表す。本番公開可能を意味しない。顧客確認、権利、問い合わせ機能等の残件は `production_blockers` に記録する。

`content-plan.json` は営業用サイトには配信せず、運営レビューと生成記録に使う。
