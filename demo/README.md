# デモ（モック・ローカルのみ）

ブラウザでSiteOfferの流れを確認するための一括起動です。**モックとローカルだけ**で動きます。

- 実在企業への連絡・実在サイトへのアクセスはしません。企業候補は架空企業のフィクスチャ（`fixtures/discovery`）、
  診断の収集は取得済みの `fixtures/audit/collected/kakuu-koumuten.collected.json`（架空）を全社で共通に使います。
- 生成はモック（`fixtures/codex` の固定応答）です。生成の入力も `fixtures/codex/input.json`（架空企業「株式会社あおば工務店」）に固定するため、
  **どの企業の提案・デモサイト・納品サイトも同じ架空企業の内容**になります。モックでの成功は実生成の成功ではありません。
- 実Codex・国税庁API・PageSpeed Insights・AWS・Dockerは使いません。ルートの `.env` は読まず、実APIのキーは子プロセスへ渡しません。
- 評価設定は `config/site-evaluation.demo.json`（**デモ用の仮値。ユーザーが決めた値ではない**）を使います。
  正の設定 `config/site-evaluation.json` の閾値は `null`（未決）のままです。
- 販売条件・報酬条件の版 `demo-2026-10`（価格30万円・月額5千円・報酬は価格の10%）も**デモ用の仮値**です。

## 起動・停止

Node.js 24以上と pnpm、`python3`（診断の採点スクリプト）が必要です。リポジトリのルートで実行します。

```sh
pnpm install
pnpm demo          # 起動。データは .data/demo に残る（Git対象外）
pnpm demo:reset    # .data/demo を消してから起動（作り直し）
pnpm demo:users    # 別の端末で、デモ用アカウントのメール・パスワードを表示
```

`pnpm demo` は次を順に起動し、**Ctrl+C で全部止めます**（どれかが異常終了したときも全部止めます）。

| 役割 | 場所 | 内容 |
| --- | --- | --- |
| DB | 127.0.0.1:54329 | PGlite（`.data/demo/pglite`）。起動時にマイグレーション |
| シード | — | デモ用アカウント・利用条件・販売条件／報酬条件の版（何度実行しても増えない） |
| web | http://localhost:3100 | Next.js（開発モード） |
| プレビュー | http://localhost:3200 | 共有リンク（`/s/<token>/`）からだけ成果物を配信。`/` は404が正常 |
| ワーカー | — | pg-boss のキュー＋DBの受付処理（3秒ごと） |

- ポート 54329・3100・3200 のどれかが使用中なら起動しません。`pnpm dev:db`・`pnpm dev`（Docker）・別の `pnpm demo` を止めてから実行します。
- 成果物（デモサイト・納品サイト・診断結果）は `.data/demo/artifacts`・`.data/demo/audits` に置きます。
- DBはPGlite（1セッション）です。デモ用の受け口（`demo/pglite-server.ts`）が、問い合わせ・トランザクションの単位で接続を順番に処理します。
  実PostgreSQLでの同時実行の検証の代わりにはなりません。

## デモ用アカウント

**デモ専用。本番で使わない。** パスワードは初回のシードで乱数から作り、`.data/demo/users.json`（権限600・Git対象外）にだけ保存します。
`pnpm demo:users` で表示します。`pnpm demo:reset` で作り直すとパスワードも変わります。

| 役割 | メール |
| --- | --- |
| 運営 | ops@example.test |
| 営業 | sales@example.test |
| 営業2（担当の重複・権限の確認用） | sales2@example.test |

`example.test` は実在しないドメインです。メールは送信されません。

## デモの流れ

画面の一部（運営の納品画面、営業の共有リンク、ログイン後の移動先）は並行して作成中です。
**ボタン名・リンクの位置は画面側の取り込み後に更新します。** 下のURLはその前提で書いています。

1. **収集**（運営）：`/login` で運営アカウントでログイン → `/ops/discovery` で収集ジョブを作る（取得元はフィクスチャ）。
   ワーカーが数秒以内に拾い、架空企業を取り込みます。公式サイトが確認済みの6社は自動で診断へ進みます。
   公式サイトが候補・確認待ちの企業は、運営の確認待ちのまま残ります。
2. **診断・生成・レビュー**（運営）：診断（デモ用の閾値で判定 create）→ 提案文・電話台本・想定問答・デモサイトの生成（モック）→
   デモサイトのビルドまで自動で進み、企業が「運営確認待ち」になります（1社あたり数十秒。提案は1社ずつ順に処理）。
   `/ops/review` で提案版を確認し、承認します。
3. **営業可能化**（運営）：`/ops/companies/<企業ID>` で販売条件・報酬条件の版 `demo-2026-10` を選んで営業可能にします。
4. **担当確保・活動記録**（営業）：別のブラウザ（またはシークレットウィンドウ）で営業アカウントでログイン →
   `/sales/companies` で企業を選んで担当を確保 → `/sales/assignments/<担当ID>` で活動を記録、ドメイン希望を聞き取ります。
   改善デモはプレビュー（`http://localhost:3200/s/<token>/`）の共有リンクで開きます（共有リンクの発行は画面側の取り込み後に更新）。
   営業2で同じ企業を確保しようとすると、担当の重複として断られることを確認できます。
5. **成約報告**（営業）：担当の画面から成約を報告します。
6. **契約確認**（運営）：`/ops/contracts` で契約を確認・完了にします。報酬は契約の完了で1件だけ発生します（`/sales/earnings` で確認）。
7. **納品・顧客確認**（運営 → 顧客）：`/ops/delivery` で納品を始め、情報確認を終えて「制作」に進めます。
   ワーカーが数秒以内に拾い、納品サイト（モックの生成＋Astroのビルド）を制作版として追加して「運営確認」に進めます。
   運営が版を確認して顧客確認に回すと、顧客用リンク（`/review/<token>`）が発行されます。
   そのリンクを開き、顧客として承認するか修正を依頼します。修正依頼で「制作」に戻ると、ワーカーが新しい版を作ります。
   公開・納品は状態の記録だけです（AWSへの公開はしません）。

## 環境変数（`pnpm demo` が子プロセスに設定する値）

| 変数 | 値 | 対象 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres@127.0.0.1:54329/postgres` | 全部 |
| `SITEOFFER_GENERATOR` | `mock` | ワーカー |
| `SITEOFFER_DISCOVERY_PROVIDERS` | `fixture` | ワーカー |
| `SITEOFFER_AUDIT_COLLECTOR` | `fixture` | ワーカー |
| `SITEOFFER_EVAL_CONFIG` | `config/site-evaluation.demo.json` | ワーカー |
| `SITEOFFER_GENERATION_INPUT` | `fixture`（モック生成器のときだけ使える） | ワーカー |
| `SITEOFFER_PROPOSAL_CONCURRENCY` | `1` | ワーカー |
| `SITEOFFER_INTAKE_INTERVAL_MS` | `3000`（`0` で受付処理を止める） | ワーカー |
| `SITEOFFER_DEMO_ARTIFACT_DIR`・`SITEOFFER_DELIVERY_ARTIFACT_DIR`・`SITEOFFER_AUDIT_ARTIFACT_DIR` | `.data/demo/...` | ワーカー |
| `PREVIEW_PORT`・`PREVIEW_ARTIFACT_BASE_DIR` | `3200`・`.data/demo/artifacts` | プレビュー |
| `PREVIEW_ORIGIN`（と同じ値の `PREVIEW_BASE_URL`） | `http://localhost:3200` | web |

ポートは `DEMO_DB_PORT`・`DEMO_WEB_PORT`・`DEMO_PREVIEW_PORT` で変えられます。
