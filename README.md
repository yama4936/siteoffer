# SiteOffer

企業サイトの改善機会を自動で見つけ、AIで改善案とサイトを作成し、営業パートナーが提案・契約を進めるサービス。
契約後は運営が制作、クラウド環境の整備、公開まで担当する。

ローカルMVPを開発中です。営業・運営・顧客確認の画面、認証と業務処理、ワーカーとプレビュー配信、改善後サイトのスキル、画像素材の権利管理を実装しています。
ローカルのデモでは、収集から納品・顧客確認まで最後までブラウザで操作できます（生成はモック）。現在のChatGPTログインでCodex SDKの実応答（認証確認のみ）を確認済みです。
アプリからの実生成、企業収集の実API実行、AWS構築、本番公開、実契約は未実施です。現時点の到達点と限界は [docs/REPORT.md](docs/REPORT.md) にまとめています。

## ローカルで起動する

**Dockerがない環境でデモを見る場合**は `pnpm demo` を使います（モックの生成器と架空企業のフィクスチャだけで動き、実在企業・実API・AWSは使いません）。
手順・デモ用アカウント・画面の流れは [demo/README.md](demo/README.md) を参照してください。
実在企業の評価結果（reports/sites、Git対象外）は、`pnpm reports:import` でDBに取り込み、`pnpm demo:promote-imported` でデモのDBに限り営業可能まで進められます（提案文・デモサイトはモックのまま。デモで表示するのは85点以下）。接続先の指定などは [docs/DECISIONS.md](docs/DECISIONS.md) の作業AD・AEを参照してください。

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

## 現在のCodexアカウントを生成に使う

現在のCodex desktop/CLIのChatGPTログインを共有します。APIキーは不要です。
通常のComposeワーカーはモックです。実Codexへ切り替える場合は次の順で実行します。

```sh
pnpm dev:setup       # .envがない場合だけ、アプリのローカル設定を用意
pnpm codex:setup      # .envへ認証ファイルの参照・実行UIDを設定し、生成用イメージを作る
pnpm codex:sandbox-check # ダミー認証・ネットワークなしでWindowsのパスや隔離・結果の受け渡しを検査
pnpm codex:check      # 使い捨てコンテナ内のSDKで短い実応答を確認（Codex利用枠を消費）
pnpm codex:worker     # Composeのモックワーカーを停止し、ホスト側の実ワーカーを起動
```

ワーカーの制御プロセスはホスト側で動かし、Codex SDKはジョブごとのDockerコンテナ内で実行します。
これにより、通常のアプリコンテナへDockerソケットやCodex認証を渡す必要がありません。
生成用イメージはNode.js 24と固定したSDKから単独でビルドできます。アプリ用イメージの事前ビルドは不要です。
WindowsではDocker Desktopを起動してください。空白・日本語を含むドライブの絶対パスに対応し、認証ファイルの参照先は `.env` にスラッシュ区切りで保存します。
既存デモの稼働確認だけなら、`.env` の作成や実ワーカーへの切替は不要です。上記手順は実Codexを使う通常環境の設定です。
認証を設定せず隔離処理だけ確認する場合は、`docker build -f Dockerfile.codex -t siteoffer-codex:local .` と `pnpm codex:sandbox-check` を使えます。
各実行に固有のIDを割り当て、現在のIDと一致した結果だけを受け取ります。古い生成イメージはIDを返さないため、ランナー更新後は生成用イメージも再ビルドしてください。
ホスト側ワーカーはターミナルのCtrl+Cで停止します。モックに戻す場合は、ホスト側を停止してから `pnpm dev` を実行します。
両方のワーカーを同時に動かさないでください。

元の `auth.json` は読み取り専用でマウントし、現在のアクセス認証をコンテナの一時ホームに置きます。
元ファイルの更新トークンをコンテナの認証には使わず、デスクトップとの更新競合を避けます。
期限切れの場合はデスクトップ/CLI側で認証を更新してから再試行します。元の認証ファイルをGitや画面へ出しません。
ホストの `.env` は認証ファイルのパスだけを保存し、トークンは保存しません。

生成モデルの選定は引き続き未決です。`SITEOFFER_CODEX_MODEL` が空ならCLIの既定を使い、応答のモデルIDが取得できなければ不明として記録します。
国税庁・検索・サイト収集は引き続き架空フィクスチャ設定で、評価閾値も `null` のままです。
ローカルの生成ネットワークはDockerの `bridge` です。送信先をOpenAIだけに限定するプロキシは未実装です。
認証共有の公式説明：[Codex Authentication](https://learn.chatgpt.com/docs/auth)。

## 読む順番

1. [REQUIREMENTS.md](REQUIREMENTS.md)：確定方針、機能要件、推奨仕様、未決事項、受け入れ条件。
2. [docs/REPORT.md](docs/REPORT.md)：作業報告書。目的、要件決定の過程、AIの利用、成果物、検証、未達と今後の作業。全画面のスクリーンショット付きPDF版は `reports/report/`（実在企業が写るためGit対象外）。
3. [docs/DECISIONS.md](docs/DECISIONS.md)：判断記録。開発の流れ、Claude Codeでの開発（セッション・subagent）、判断の一覧、作業記録。付録にCodexとClaude Codeの会話記録、ターン別モデル情報。
4. [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)：ローカルMVPの実装計画と、subagentへのタスク分割。
5. [AGENTS.md](AGENTS.md)：今後このリポジトリで作業するエージェントへの指示。
6. [.agents/skills/](.agents/skills/)：サイト評価（site-evaluation）、改善提案書（site-proposal）、改善後サイトの作成（site-rebuild）のスキル。設定は [config/site-evaluation.json](config/site-evaluation.json)。

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
- 改善提案書を作る評価の閾値は未決（`config/site-evaluation.json` は `null`）。実在サイトの評価データを見てユーザーが決める。デモの85点以下は仮の表示条件。
- ブログ・お知らせなど顧客が更新できる機能は、全社共通のオプションとして自社アプリの共通更新画面で作る。生成サイトの更新・公開・運用では、AWSと認証以外の外部サービスに依存しない。
- 画像は1点ごとに出所・権利状態・利用範囲を管理し、許諾を確認していない画像はデモ・本番に使わない。

過去のSitePitch、Supabase中心の構成、企業の手動登録を主経路にする案は、最新方針に置き換わっている。
担当の初期値（同時3社・未着手72時間で解除）、共有リンクの有効期間14日、生成の上限（試行3回・15分・同時2）は、アシスタントの推奨をユーザーが承認した値。1ページの商品は推奨のままで、ユーザーの確定指示ではない。

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
