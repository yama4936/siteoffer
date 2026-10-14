# 評価結果の出力形式

保存先：`reports/sites/<正規化ドメイン>/<YYYY-MM-DD>/`

| ファイル | 作成者 | 内容 |
| --- | --- | --- |
| collected.json | scripts/collect.py | 観測した生データ |
| screenshot-mobile.png / screenshot-desktop.png | collect.py（--screenshot） | 描画結果 |
| evaluation.json | エージェント＋scripts/score.py | 採点結果。アプリに取り込める形 |
| evaluation.md | エージェント | 人が読む評価書 |

再診断では日付の新しいディレクトリを作る。過去の結果は上書きしない（REQUIREMENTS.md §9 の再診断・更新日時）。

## evaluation.json

`summary` は score.py が書き込む。エージェントは書かない。

```json
{
  "schema_version": "0.1",
  "rubric_version": "0.1",
  "status": "evaluated",
  "target_url": "https://example.co.jp/",
  "final_url": "https://example.co.jp/",
  "collected_at": "2026-10-14T15:00:00+09:00",
  "evaluated_at": "2026-10-14T15:20:00+09:00",
  "evaluator": {"skill": "site-evaluation", "model": "実行記録で確認できたモデルID、なければ「不明」"},
  "conditions": {"pages": ["top", "company", "contact"], "screenshot": true, "pagespeed": "failed: ..."},
  "company": {"name": "株式会社例", "name_source": "会社概要ページの表記", "location": "愛知県名古屋市…", "location_source": "https://example.co.jp/company/", "industry_guess": "住宅リフォーム"},
  "site_context": {
    "purpose_guess": "地域の個人客からのリフォーム相談の獲得",
    "target_guess": "名古屋市内の戸建て所有者",
    "primary_conversion_guess": "電話・見積もりフォーム",
    "basis": "トップのh1と、サービス一覧が個人向け工事であること",
    "is_inference": true
  },
  "items": [
    {
      "id": "A1",
      "status": "scored",
      "level": 1,
      "observations": [
        {"fact": "問い合わせへのリンクはフッターのみ。ヘッダーにない", "url": "https://example.co.jp/", "evidence": "フッター内リンク「お問い合わせ」/ screenshot-mobile.png 下端"}
      ],
      "reason": "スマホでは最下部までスクロールしないと連絡手段に辿り着けないため",
      "inference": false,
      "improvement_hint": "ヘッダーとファーストビューに電話・見積もりボタンを常設"
    },
    {
      "id": "D2",
      "status": "unevaluable",
      "reason": "描画環境がなくスクリーンショットを取得できなかった"
    }
  ],
  "critical_flags": [
    {"id": "CF-NOT-MOBILE", "item": "D1", "fact": "viewport メタタグなし"}
  ],
  "sales_notes": {
    "product_fit": "1ページサイトで改善可能。予約機能なし",
    "proposal_ease": "サービス写真・施工事例が公開されており、デモ素材の参考にできる（利用権は未確認）",
    "web_dependency_guess": "高（推測：地域の個人客はWeb検索で業者を探す傾向）",
    "existing_vendor": "フッターに「制作：○○デザイン」",
    "recent_renewal_signs": "なし。copyright 2016",
    "budget_decision_maker": "不明"
  },
  "summary": {}
}
```

- 取得自体に失敗したら `"status": "unevaluable"` とし、`fatal_reason` に理由を書く。items は全項目 unevaluable。低評価として扱わない。
- 企業名・所在地は出典がある場合だけ書く。キーワードの地名だけで所在地を断定しない（REQUIREMENTS.md §8.1）。

## evaluation.md

次の構成で書く。読み手は運営と営業ユーザー。専門用語は避け、使う場合は一言で説明する。

```markdown
# サイト評価：<企業名またはドメイン>

| 項目 | 値 |
| --- | --- |
| 対象URL | … |
| 取得日時 / 評価日時 | … |
| 総合点 | NN / 100（カバー率 NN%）または「判定保留：理由」 |
| 致命項目 | なし / CF-… |
| 評価条件 | 取得ページ、スクリーンショット有無、速度測定の有無 |

## 1. 要点
3行以内。最も大きい課題と、それが目的に与える影響。

## 2. サイトの目的と想定顧客（推定）
目的・想定顧客・主な成果（問い合わせ等）と、その推定の根拠。

## 3. カテゴリ別の点数
score.py が出力した表を貼る。

## 4. 項目別の評価
カテゴリごとに、項目・レベル・観測事実（URLと場所）・理由。評価不能と該当なしも理由を書く。

## 5. 強み
維持すべき良い点。提案時に否定しないため。

## 6. 営業メモ（採点外）
sales_notes の内容。予算・決裁者は「不明」。

## 7. 評価の限界
取得できなかったページ、描画・速度測定の有無、推測を含む項目。
```
