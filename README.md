# SiteOffer

企業サイトの改善機会を自動で見つけ、AIで改善案とサイトを作成し、営業パートナーが提案・契約を進めるサービス。
契約後は運営が制作、クラウド環境の整備、公開まで担当する。

ローカルMVPを開発中です。営業・運営画面、認証と業務処理、ワーカーとプレビュー配信を実装しています。外部API実行・AWS構築・本番公開は未実施です。

## ローカルで起動する

Docker Desktop（Compose v2）、Node.js 24以上、pnpm（指定版は12.11.2）が必要です。
リポジトリのルートで実行します。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

初回は `.env` にランダムなDBパスワードを作り、PostgreSQL 17、Next.js、ワーカー、別ポートのプレビューをDockerで起動します。
マイグレーションと開発用の利用条件・ユーザー作成が完了してからWeb画面が起動します。
既存の `.env` は上書きしません。手動で作った場合は `.env.example` を参考に `POSTGRES_PASSWORD` を設定してください。
通常は [ログイン画面](http://localhost:3100/login) を開きます。

```sh
pnpm dev:users        # 自分の端末で開発用メール・パスワードを表示
pnpm dev:check        # 実DBのログイン・画面応答・役割境界を確認
docker compose ps    # 起動状態
docker compose logs --tail 50 web
pnpm dev:stop        # 停止（DBデータを保持）
```

運営は `ops@example.test` でログインして `/ops`、営業は `sales@example.test` で `/sales` を開きます。
営業の自己登録は `/register` です。仮の利用条件は開発用で、本番用の確定文面ではありません。
起動時のDBは空で、実在企業の取り込み・評価・生成は自動実行しません。
ワーカーは架空企業のフィクスチャ、取得済みの診断データ、モック生成器に固定しています。実Codexの認証情報やAPIキーは渡しません。
閾値は未決の `null` のままで、診断後の自動提案生成は保留になります。
Webは `127.0.0.1:3100`、プレビューは `127.0.0.1:3200`、DBは `127.0.0.1:54329` に限定して公開します。
プレビューの `/` は404が正常です。有効な共有リンクからだけ成果物を閲覧できます。
Composeのポートは `.env` の `WEB_PORT`、`PREVIEW_PORT`、`DATABASE_PORT` で変更できます。DBポート変更時は `DATABASE_URL` も合わせて変更します。

DBデータはDockerの `siteoffer_postgres-data` ボリューム、開発用ログイン情報は `.data/dev-users.json` に保存します。
`.env` と `.data/` はGit対象外です。再起動・再実行でユーザーやパスワードは変わりません。
ワーカーの成果物はGit対象外の `reports/` に保存し、プレビュー側には読み取り専用で渡します。
`docker compose down --volumes` はDBを削除するため、通常の停止には使わないでください。
アプリのコンテナはソースをビルド時にコピーするため、変更の反映には再度 `pnpm dev` を実行します。
このイメージは開発用で、企業ごとの生成コードを実行する隔離イメージとは別です。

### ホスト側で画面を開発する

```sh
pnpm dev:setup
docker compose up --detach --wait db
pnpm db:migrate
pnpm dev:seed
pnpm dev:web
```

ComposeのWebが起動中なら先に `docker compose stop web` を実行します。
ホスト側の `pnpm dev:web` はルートの `.env` を読み、`127.0.0.1:3100` で起動します。Dockerなしの場合は `pnpm dev:db` でPGliteを起動し、
`.env` の `DATABASE_URL` を `.env.example` 内のPGlite用URLに変更してから `pnpm dev:seed` と `pnpm dev:web` を実行できます。
PGliteは開発・テスト用で、実PostgreSQLの同時トランザクション検証を代替しません。

```sh
pnpm check           # 型検査・Lint・自動テスト（外部APIはモック）
```

## 読む順番

1. [REQUIREMENTS.md](REQUIREMENTS.md)：確定方針、機能要件、推奨仕様、未決事項、受け入れ条件。
2. [docs/DECISIONS.md](docs/DECISIONS.md)：判断記録。開発の流れ、Claude Codeでの開発（セッション・subagent）、判断の一覧、作業記録。付録にCodexとClaude Codeの会話記録、ターン別モデル情報。
3. [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)：ローカルMVPの実装計画と、subagentへのタスク分割。
4. [AGENTS.md](AGENTS.md)：今後このリポジトリで作業するエージェントへの指示。
5. [.agents/skills/](.agents/skills/)：サイト評価（site-evaluation）と改善提案書（site-proposal）のスキル。設定は [config/site-evaluation.json](config/site-evaluation.json)。

## 最新の方針

- 名前：SiteOffer。リポジトリ名：siteoffer。
- 営業ユーザーは営業のみ。企業の候補をユーザー自身に登録させない。
- 企業の候補は運営側の仕組みで自動収集する。地域・業種などで絞り込む。
- GPTのSDKでサイトを作成する。Codex SDKでサイトと提案文章を生成する。生成モデルIDは未決。
- 当面はローカルで動かす。Webアプリ、TypeScript、Next.js＋ワーカー、PostgreSQL、Astroの静的サイト生成。詳細はREQUIREMENTS.mdの24章。
- 企業候補は国税庁法人番号APIと検索系APIで収集する。検索系APIの製品は未決。
- クラウド管理にはAWSを使う。現時点で構築・デプロイは進めない。
- ドメインについて営業ユーザーが希望の聞き取り・提案を行う。実際の設定・移管は運営が担当する。
- 報酬は契約完了で発生する。支払日・金額・キャンセル時の扱いは未決。

過去のSitePitch、Supabase中心の構成、企業の手動登録を主経路にする案は、最新方針に置き換わっている。
1ページの商品、72時間の担当期限、同時3社などはアシスタントの推奨値であり、ユーザーの確定指示ではない。

## 開発を引き継ぐ際の指示文

    REQUIREMENTS.md、docs/DECISIONS.md、AGENTS.mdを読み、SiteOfferの開発を進めてください。
    確定事項と推奨・未決事項を区別し、最新のユーザー指示を優先してください。
    AWSの実環境構築・本番公開は、まだ開始しないでください。
    Codex SDKによる生成と、企業候補の自動収集を独立したインターフェースで扱ってください。
    モックの成功を実サービスの成功として報告しないでください。
    作業したモデル、ユーザーの依頼、判断・変更、検証結果、未完了事項をdocs/DECISIONS.mdに短く追記し、
    最終的にこの記録から報告書を作成できるようにしてください。

## 記録の扱い

記録はdocs/DECISIONS.md（判断記録）1つに追記していく。自動で読む指示ファイルのAGENTS.mdとは別の役割。
会話履歴には方針が変わる前の回答も残る。現行要件はREQUIREMENTS.mdを参照する。
会話の新しい記録を追加するときは、認証情報や内部の推論を含めず、公開された発言・回答を記録する。
