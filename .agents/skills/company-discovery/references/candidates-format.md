# candidates.json の形式

`scripts/import-discovery.ts` が読む。形式が違うと取り込み前にエラーで止まる。

```json
{
  "criteria": { "prefecture": "愛知県", "city": "名古屋市", "industry": "工務店", "keywords": [] },
  "run": { "started_at": "2026-10-27T10:00:00+09:00", "model": "<実行記録で確認できたモデルID。不明なら「不明」>" },
  "candidates": [
    {
      "name": "株式会社〇〇工務店",
      "corporate_number": null,
      "prefecture": "愛知県",
      "city": "名古屋市緑区",
      "address": "愛知県名古屋市緑区〇〇1-2-3",
      "address_source_url": "https://example.co.jp/company/",
      "industry": "工務店",
      "representative_phone": null,
      "found_via": { "url": "https://<名簿のURL>", "note": "〇〇組合 会員名簿" },
      "fetched_at": "2026-10-27T10:05:00+09:00",
      "official_site": {
        "url": "https://example.co.jp/",
        "evidence_url": "https://example.co.jp/company/",
        "evidence": { "company_name": "株式会社〇〇工務店", "address": "愛知県名古屋市緑区〇〇1-2-3", "corporate_number": null }
      },
      "other_sites": [{ "url": "https://www.instagram.com/xxxx/", "third_party": true }],
      "size_check": { "listed": false, "capital": "1,000万円", "employees": "12名", "franchise_or_branch": false, "source_url": "https://example.co.jp/company/", "note": "" }
    }
  ],
  "excluded": [
    { "name": "△△ホーム 名古屋支店", "reason": "支店（本社は東京都）", "source_url": "https://..." }
  ]
}
```

## 項目

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| criteria | ○ | 収集条件。`prefecture`・`city`（市区町村は都道府県とセット）・`industry`・`keywords`。`limit` は候補数から自動で入る |
| name | ○ | 公式サイト等に書かれた正式な社名（法人格を含む） |
| corporate_number | | 13桁。法人番号公表サイト等で確認できたときだけ |
| prefecture / city / address | | 出典で確認した所在地。`city` は「名古屋市緑区」のように市区町村まで。`address_source_url` がないと取り込みで捨てる |
| address_source_url | | 所在地を確認したページ |
| found_via | ○ | 企業を見つけたページ。取り込み後の出典（discovery_sources.source_url）になる |
| fetched_at | ○ | 確認した日時（タイムゾーン付き ISO 8601） |
| official_site | ○ | 公式サイト。見つからなければ null |
| official_site.evidence | ○ | `evidence_url` のページ上に書かれていた社名・所在地・法人番号。書かれていなければ null。推測で埋めない |
| other_sites | | ポータル・SNS等。`third_party: true` |
| size_check | | 除外条件の確認結果と出典。取り込み時に出典の付帯情報として保存する |
| excluded | | 除外した企業と理由・出典。取り込まない |

## 確度の決まり方（取り込み時に自動）

packages/discovery の judgeOfficialSite による。

- `confirmed`：evidence の法人番号が一致、または社名と市区町村が一致
- `candidate`：社名は一致するが、所在地がページ上で確認できない
- `needs_review`：第三者サイトしかない、社名がページ上にない、同名の別企業（所在地が違う）
- `not_found`：official_site も other_sites もない

evidence と所在地の `address` は都道府県から書き、郵便番号（〒）を先頭に付けない。付けると所在地が一致しない判定になる。
evidence の社名は法人格（株式会社・（株）等）と空白を除いて比べる。屋号しか書かれていないサイトは社名不一致になるので、そのときは evidence に屋号を書かず null にし、確認待ちとして報告する。
