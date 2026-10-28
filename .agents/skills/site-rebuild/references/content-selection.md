# 企業ごとの掲載情報の選定

site-rebuild の手順3で使う。HTMLを作る前に、取得できた情報からその企業の営業デモへ載せる内容を選び、`$OUT/site/content-plan.json` に確定する。

## 選定基準

情報量を増やすこと自体ではなく、訪問者が判断するために必要な問いへ、確認済みの企業固有情報で十分に答えることを優先する。短いトップコピーだけで「答えた」とせず、元サイトに有用な詳細がある場合は詳細ページへ保持する。

1. 何の会社で、何を提供しているか
2. 誰・どの地域・どの課題が対象か
3. 依頼先として判断できる具体的な根拠があるか
4. 依頼内容・条件・実績を具体的に判断できるか
5. どの会社が責任を持ち、次に何をすればよいか

企業ごとに答えられる問いは異なる。確認できない問いを一般論や定番コピーで埋めない。サービス、実績、会社概要、流れ、FAQ、お知らせを名前だけの必須セクションにしない。一方、確認済みの詳細があるのに「簡潔な1ページ」にするため削除もしない。情報完結性とページ分割は [site-completeness.md](site-completeness.md) に従う。

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
  "schema_version": "0.3",
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
  "source_coverage": {
    "status": "complete",
    "observed_navigation": ["トップ", "業務内容", "会社概要", "お問い合わせ"],
    "collected_sources": ["pages[role=top]", "pages[role=service]", "pages[role=company]", "pages[role=contact]"],
    "missing_sources": [],
    "basis": "スクリーンショットの主メニューと取得ページを照合"
  },
  "decision_coverage": [
    {"id": "identity", "status": "answered", "answered_by": ["company-name"], "reason": "正式名称と所在地を確認"},
    {"id": "offer", "status": "answered", "answered_by": ["service-inheritance"], "reason": "主要業務の説明を確認"},
    {"id": "fit", "status": "not_applicable", "answered_by": [], "reason": "対象条件を限定する記載がなく、このデモで断定しない"},
    {"id": "specifics", "status": "answered", "answered_by": ["service-inheritance"], "reason": "依頼内容を確認"},
    {"id": "proof", "status": "not_applicable", "answered_by": [], "reason": "確認済みの事例・資格がないため、事実を作らない"},
    {"id": "trust", "status": "answered", "answered_by": ["company-name"], "reason": "会社の正式名称を確認"},
    {"id": "action", "status": "answered", "answered_by": ["primary-phone"], "reason": "電話窓口を確認"}
  ],
  "site_architecture": {
    "mode": "multi_page",
    "reason": "取扱業務にトップの要約を超える確認済みの詳細説明がある",
    "primary_navigation": ["index.html", "services.html"],
    "mobile_content_equivalence_reviewed": true
  },
  "page_plan": [
    {"file": "index.html", "purpose": "会社と主要業務を理解し詳細へ進む", "audience_questions": ["identity", "offer", "action"], "content_ids": ["company-name", "service-inheritance", "primary-phone"], "reason_separate": "サイト全体の入口"},
    {"file": "services.html", "purpose": "取扱業務を具体的に判断する", "audience_questions": ["offer", "specifics"], "content_ids": ["service-inheritance"], "reason_separate": "確認済みの詳細説明がトップの要約を超えるため"}
  ],
  "media_plan": {
    "usable_assets": [],
    "excluded_assets": ["許諾未確認の元サイト画像"],
    "missing_essential_assets": [],
    "notes": "事実を示す画像を使わず、文字情報で判断できる構成"
  },
  "update_plan": {
    "mode": "fixed_fields_only",
    "connection_status": "planned",
    "content_types": [],
    "placements": [],
    "migration_required": false,
    "reason": "継続記事はなく、確認済みの会社情報だけを固定項目として更新する"
  },
  "source_content_inventory": [
    {
      "id": "source-company-name",
      "kind": "identity",
      "label": "正式名称",
      "importance": "essential",
      "source_refs": [{"artifact": "evaluation.json", "path": "company.name"}],
      "source_text_length": 5,
      "disposition": "retained",
      "target_content_ids": ["company-name"],
      "target_pages": ["index.html"],
      "reason": "正式名称を保持"
    },
    {
      "id": "source-service-inheritance",
      "kind": "service",
      "label": "相続登記の相談内容",
      "importance": "essential",
      "source_refs": [{"artifact": "collected.json", "path": "pages[role=service].text_excerpt", "url": "https://example.jp/service/"}],
      "source_text_length": 640,
      "disposition": "consolidated",
      "target_content_ids": ["service-inheritance"],
      "target_pages": ["index.html", "services.html"],
      "reason": "重複をまとめ、条件と意味を保った完成文として配置"
    },
    {
      "id": "source-primary-phone",
      "kind": "contact",
      "label": "電話窓口",
      "importance": "essential",
      "source_refs": [{"artifact": "collected.json", "path": "pages[role=top].tel_links", "url": "https://example.jp/"}],
      "source_text_length": 13,
      "disposition": "retained",
      "target_content_ids": ["primary-phone"],
      "target_pages": ["index.html"],
      "reason": "番号と発信先を保持"
    },
    {
      "id": "source-spring-event",
      "kind": "news",
      "label": "春の相談会",
      "importance": "optional",
      "source_refs": [{"artifact": "collected.json", "path": "pages[0].text_excerpt", "url": "https://example.jp/"}],
      "source_text_length": 80,
      "disposition": "excluded",
      "target_content_ids": [],
      "target_pages": [],
      "reason": "開催年と終了日を確認できない"
    }
  ],
  "feature_inventory": [
    {
      "id": "feature-primary-navigation",
      "kind": "navigation",
      "original_behavior": "トップと業務内容ページを移動できる",
      "importance": "supporting",
      "evidence": [{"artifact": "collected.json", "path": "site.navigation_links_top", "url": "https://example.jp/"}],
      "handling": "preserved",
      "target": "index.html と services.html の通常リンク",
      "target_refs": [{"artifact": "html", "path": "index.html"}, {"artifact": "html", "path": "services.html"}],
      "user_visible_difference": "リンク名を保ち、全ページで同じ順序に統一",
      "verification_status": "verified"
    },
    {
      "id": "feature-primary-phone",
      "kind": "contact",
      "original_behavior": "電話リンクから発信できる",
      "importance": "primary",
      "evidence": [{"artifact": "collected.json", "path": "pages[role=top].tel_links", "url": "https://example.jp/"}],
      "handling": "preserved",
      "target": "index.html の tel: リンク",
      "target_refs": [{"artifact": "html", "path": "index.html"}, {"artifact": "content-plan.json", "path": "primary-phone"}],
      "user_visible_difference": "表示位置のみ改善し、発信先は同じ",
      "verification_status": "verified"
    },
    {
      "id": "feature-inquiry-form",
      "kind": "form",
      "original_behavior": "問い合わせ内容を送信できる",
      "importance": "primary",
      "evidence": [{"artifact": "collected.json", "path": "pages[role=contact].forms", "url": "https://example.jp/contact/"}],
      "handling": "planned",
      "target": "admin-schema.json inquiry_form と将来のSiteOffer受付API",
      "target_refs": [{"artifact": "admin-schema.json", "path": "inquiry_form"}],
      "user_visible_difference": "非公式デモでは送信せず、本番接続後に利用可能",
      "verification_status": "planned"
    }
  ],
  "parity_review": {
    "unaccounted_content_ids": [],
    "unaccounted_feature_ids": [],
    "demo_status": "complete",
    "production_status": "gaps_remaining",
    "information_summary": {"source_items": 4, "retained": 2, "consolidated": 1, "excluded": 1, "blocked": 0},
    "feature_summary": {"source_features": 3, "preserved": 2, "replaced": 0, "planned": 1, "out_of_scope": 0, "blocked": 0},
    "comparison_notes": "元サイトの情報と機能を意味単位で全件照合。文字数とページ数は参考値で、問い合わせ送信は本番接続前の残件"
  },
  "fact_verification": {
    "company_identity_checked": true,
    "claims": [
      {
        "id": "claim-company-name",
        "kind": "identity",
        "statement": "正式名称は株式会社例",
        "content_ids": ["company-name"],
        "source_refs": [{"artifact": "evaluation.json", "path": "company.name", "evidence": "会社名欄", "observed_at": "2026-10-28T12:00:00+09:00"}],
        "freshness": {"status": "timeless", "basis": "評価時点の会社名"},
        "conflicts": [],
        "surfaces": ["body", "title"],
        "source_value": "株式会社例",
        "display_value": "株式会社例",
        "status": "verified"
      },
      {
        "id": "claim-service-inheritance",
        "kind": "service",
        "statement": "相続登記の相談を受け付けている",
        "content_ids": ["service-inheritance"],
        "source_refs": [{"artifact": "collected.json", "path": "pages[role=service].text_excerpt", "evidence": "相続登記の相談案内", "observed_at": "2026-10-28T12:00:00+09:00"}],
        "freshness": {"status": "current", "basis": "取得時点の恒常的な業務案内"},
        "conflicts": [],
        "surfaces": ["body", "title", "description"],
        "status": "verified"
      },
      {
        "id": "claim-primary-phone",
        "kind": "contact",
        "statement": "主要な電話窓口は00-0000-0000",
        "content_ids": ["primary-phone"],
        "source_refs": [{"artifact": "collected.json", "path": "pages[role=top].tel_links", "evidence": "トップの電話リンク", "observed_at": "2026-10-28T12:00:00+09:00"}],
        "freshness": {"status": "current", "basis": "取得時点のトップページに掲載"},
        "conflicts": [],
        "surfaces": ["body", "cta"],
        "source_value": "00-0000-0000",
        "display_value": "00-0000-0000",
        "status": "verified"
      }
    ],
    "unresolved_claim_ids": [],
    "reviewed_surfaces": ["body", "title", "description", "cta", "structured_data"],
    "reviewed_at": "2026-10-28T12:30:00+09:00"
  },
  "selected_content": [
    {
      "id": "company-name",
      "kind": "identity",
      "purpose": "会社を識別できるようにする",
      "copy": {"heading": "株式会社例"},
      "placement": [{"page": "index.html", "section": "ヘッダー"}],
      "source_refs": [{"artifact": "evaluation.json", "path": "company.name", "fact": "株式会社例"}],
      "selection_reason": "確認済みの正式名称",
      "claim_ids": ["claim-company-name"],
      "source_fidelity": {
        "mode": "verbatim_fact",
        "preserved_terms": ["株式会社例"],
        "meaning_preserved": true,
        "editorial_changes": "なし"
      },
      "freshness": {"status": "timeless", "basis": "評価時点の正式名称"},
      "status": "ready"
    },
    {
      "id": "service-inheritance",
      "kind": "service",
      "purpose": "主要サービスを最初に理解できるようにする",
      "copy": {
        "heading": "相続登記のご相談",
        "body": "相続登記に関する相談を受け付けています。"
      },
      "placement": [
        {"page": "index.html", "section": "ファーストビュー"},
        {"page": "services.html", "section": "業務内容"}
      ],
      "source_refs": [
        {"artifact": "collected.json", "path": "pages[role=service].headings", "url": "https://example.jp/service/", "fact": "相続登記"}
      ],
      "selection_reason": "主要サービスとしてトップとサービスページの両方で確認できる",
      "claim_ids": ["claim-service-inheritance"],
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
      "claim_ids": ["claim-primary-phone"],
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
    "facts_verified": true,
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
- `source_coverage.status` は `complete | incomplete`。`complete` のとき `missing_sources` は空、`incomplete` のときHTML生成を止め、content-plan.json ではなく `$OUT/rebuild-blocked.json`（site-completeness.md）に記録する。完成した content-plan.json は常に `complete`。
- `source_content_inventory` は、元サイトで確認できた有用な情報を意味単位で全件持つ。`importance` は `essential | supporting | optional`、`disposition` は `retained | consolidated | excluded | blocked`。保持・統合は実在する `target_content_ids` と `target_pages` を持ち、`blocked` または重要情報の除外があれば完成扱いにしない。`source_text_length` は任意の参考値であり、合格率には使わない。
- `feature_inventory` は元サイトの利用者向け機能を全件持つ。`importance` は `primary | supporting | optional`、`handling` は `preserved | replaced | planned | out_of_scope | blocked`。`target_refs` でHTML、content ID、管理定義または対象判定へ対応付ける。保持・置換は実際に検証して `verification_status: verified`、本番接続前は `planned` とする。主要機能の `blocked | out_of_scope` は不可。主要機能の `planned` は提案デモでは許容できるが、`production_status: gaps_remaining` と本番残件が必要。
- `parity_review` は未対応情報・機能を空配列にし、台帳と同じ件数を処置別に集計する。`demo_status: complete` は比較を完了したことを表し、機能が本番接続済みという意味ではない。文字数・ページ数ではなく全件対応と重要項目の欠落ゼロで判定する。
- `fact_verification` は [fact-verification.md](fact-verification.md) に従う。企業同一性を確認し、全claimを `verified`、矛盾と未解決を0件にする。本文・title・description・CTA・構造化データを生成後に確認し、各 `selected_content[].claim_ids` とclaimの `content_ids` を相互に一致させる。
- `decision_coverage` は `identity | offer | fit | specifics | proof | trust | action` を重複なく持つ。`answered` は既存の `selected_content[].id` を `answered_by` に持ち、`not_applicable` は案件固有の理由を持つ。`missing` があれば完成扱いにしない。
- `site_architecture.mode` は `single_page | multi_page` で実在HTML数と一致させる。案件固有の `reason`、トップを含む実在HTMLの `primary_navigation`、実画面確認後の `mobile_content_equivalence_reviewed: true` を持つ。詳細は [web-standards.md](web-standards.md)。
- `page_plan` は作成する全HTMLと一致し、各ページに目的、答える問い、1件以上のcontent ID、独立させる理由を持つ。
- `media_plan` は利用可能・除外・不足する重要素材を分ける。生成画像を実績の証拠にしない。
- `update_plan.mode` は `article | fixed_fields_only`、`connection_status` は `planned | connected_verified`。`article` は記事種別と表示先を持つ。固定項目・画像・受付フォームの詳細は [admin-schema.md](admin-schema.md) に従って `admin-schema.json` へ出力し、静的デモと定義だけなら `planned` とする。
- `selected_content` は1件以上。各項目の `id` は重複させず、`purpose`、空でない `copy`、1件以上の `placement` と `source_refs`、`selection_reason`、`source_fidelity`、`freshness.status`、`status: ready` を持つ。
- `source_fidelity.mode` は `verbatim_fact | faithful_rewrite | structural_label`。保持した語を `preserved_terms` に記録し、意味を照合したときだけ `meaning_preserved: true` にする。`editorial_changes` には省略・統合・言い換えの内容を書く。
- `placement[].page` は実在するHTMLファイルと一致させる。
- `source_refs` は成果物内の位置とURLを記録する。URLがない内部成果物の場合だけ `url` を省略できる。
- `freshness.status` は `current | timeless | unclear`。`unclear` の項目は `selected_content` に入れず `excluded_content` へ移す。
- `excluded_content[].reason` は `unverified | stale_or_unclear | rights | irrelevant | duplicate | conflicting` のいずれか。
- `review` の6項目（`visible_claims_traced`、`copy_ready`、`cta_targets_verified`、`source_fidelity_reviewed`、`facts_verified`、`presentation_ready`）は、実際にHTMLと元サイト由来の材料を照合した後だけ `true` にする。1つでも確認できなければサイトを完成扱いにしない。
- `readiness.status` は `ready_for_customer_review | incomplete`。主要サービスの説明、企業識別、主要行動に必要な文章を元サイトから作れない場合は `incomplete` とし、HTML生成・DB取り込みを止め、不足を `$OUT/rebuild-blocked.json` の `blocking_gaps`（`stage: content_readiness`）に記録する。
- `ready_for_customer_review` は顧客へ見せられる文章品質を表す。本番公開可能を意味しない。顧客確認、権利、問い合わせ機能等の残件は `production_blockers` に記録する。

`content-plan.json` は営業用サイトには配信せず、運営レビューと生成記録に使う。
