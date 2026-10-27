# デモの常時公開（Cloudflare Tunnel）と main の自動反映

このマシンで動かすデモ（[demo/README.md](../../demo/README.md)）を、Cloudflare の名前付きトンネルで固定のURLから見られるようにします。
`origin/main` が進むと、このマシンが数分以内に取り込み、ビルドしてデモを再起動します（ユーザーの判断 2026-10-27、判断No.211〜213）。

- 用途は**デモ・検証用**です。本番の公開先は引き続きAWSで、要件の F-13 は変えていません。
- GitHub Actions やWebhookは使いません。このマシンが `origin/main` を定期的に確認する方式で、外からこのマシンへ入る経路を増やしません。
- 公開専用の別クローン（既定 `~/siteoffer-demo`）から動かします。作業リポジトリには触れません。公開専用クローンでは作業しないでください（自動で checkout します）。
- `--copy-data` で作業リポジトリの `.data/demo`・`reports/` を複製すると、**実在企業の名称・評価点・非公式の改善デモも公開URLから見えます**（ログインが必要な画面と期限付きの共有リンクの範囲）。

## 動き

`scripts/public-demo.sh start` は tmux のセッション `siteoffer-public` に2つの窓を作ります。

| 窓 | 内容 | ログ |
| --- | --- | --- |
| deploy | `public-demo.sh run`：起動 → `SITEOFFER_PUBLIC_INTERVAL` 秒ごとに `git fetch` → 変化があれば反映 | `~/.local/state/siteoffer-public/deploy.log` |
| tunnel | `cloudflared tunnel run`：webとプレビューのホスト名を 127.0.0.1 のポートへ中継 | `~/.local/state/siteoffer-public/tunnel.log` |

反映の手順：デモを正常停止 → 新しいコミットを checkout（detached）→ `pnpm install --frozen-lockfile` → `pnpm --filter @siteoffer/web build` →
`demo/run.ts --resume`（DBのマイグレーションは起動時に適用）→ `/login` の応答を確認。

- どこかで失敗したら、直前に反映していたコミットへ戻して再起動し、失敗したコミットを記録します。同じコミットは再試行しません（次のpushで再び試します）。
- デモが落ちていたら、次の確認のときに再起動します。
- web は本番ビルド（`DEMO_WEB_PROD=1`）で動かします。生成はモックで、実Codex・課金APIは使いません（判断No.210）。
- 既定のポートは DB 54339・web 3110・プレビュー 3210 です。手元で動かす通常の `pnpm demo`（54329・3100・3200）と同時に動かせます。

## 最初の準備（1回だけ）

Cloudflare で管理しているドメインが必要です。以下のうち `cloudflared tunnel login` はブラウザでの操作になります。

```sh
# 1. Cloudflareにログイン（~/.cloudflared/cert.pem ができる）
cloudflared tunnel login
# 2. トンネルを作り、webとプレビューのホスト名をDNSに割り当てる
cloudflared tunnel create siteoffer-demo
cloudflared tunnel route dns siteoffer-demo demo.<あなたのドメイン>
cloudflared tunnel route dns siteoffer-demo preview.<あなたのドメイン>
# 3. 設定の雛形を作り、ホスト名を書き込む（~/.config/siteoffer-public/public.env、Gitに入らない）
scripts/public-demo.sh init
# 4. 公開専用クローンとトンネル設定を作る。--copy-data で今のデモのデータを複製する
#    （作業リポジトリのデモは pnpm demo:stop で止めておく）
scripts/public-demo.sh setup --copy-data
# 5. 公開を始める
scripts/public-demo.sh start
```

`--copy-data` を付けないと、初回の起動で新しいDB（架空企業・新しいデモ用アカウント）を作ります。
複製したデータでは、DBに保存された成果物の絶対パスを `demo/rebase-paths.ts` で公開専用クローンの下へ付け替えます。複製後は作業リポジトリのデモとは別のデータです。

デモ用アカウントのパスワードは `cd ~/siteoffer-demo && pnpm demo:users` で表示します。

## 日々の操作

```sh
scripts/public-demo.sh status   # 動作状況、反映済み・失敗したコミット、ローカルと公開URLの応答
scripts/public-demo.sh stop     # トンネルを閉じてからデモを正常停止（ビルド中ならその終了を待つ）
scripts/public-demo.sh start
```

**このマシン（コンテナ）を再起動したら `scripts/public-demo.sh start` を手で実行します。** このマシンには systemd・cron がなく、
supervisord の設定は管理者権限が必要なため、起動時の自動開始は設定していません。

## 公開中の注意

- 常時公開になるため、ログイン試行回数の制限がないこと（作業AXの未完了）に注意してください。見せる相手が決まっているなら、
  Cloudflare Zero Trust の Access で web のホスト名にメール認証をかけるのを推奨します。顧客確認（`/review/*`）と
  プレビューの共有リンク（`/s/*`）をログインなしで見せる場合は、そのパスだけ Access の対象から外します。
- 不要になったら `stop` し、`cloudflared tunnel route dns` で作ったDNSレコードとトンネルを Cloudflare 側で削除します。
- トンネルの認証ファイル（`~/.cloudflared/*.json`・`cert.pem`）は秘密情報です。Gitやログに出さないでください。
