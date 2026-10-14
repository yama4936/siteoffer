# Docker一式（用意のみ）

SiteOffer をDockerで動かすためのファイル。REQUIREMENTS.md 24.1（docker compose でDB・アプリ・ワーカーを起動）と
24.4（生成はジョブごとの使い捨てコンテナ）に対応する。

**状態：未起動・未検証。** 作成した開発環境にはDockerがなく、イメージのビルド、compose の起動、
マイグレーション、生成用コンテナの実行は一度も行っていない。確認したのは、YAMLの構文、参照するパスの実在、
Biome の検査だけ（静的な確認）。Dockerのある環境で下の「確認項目」を順に確かめること。

> **注意（mainへの反映時に変更）**：ローカル起動に使う直下の `compose.yaml`・`.dockerignore`・`Dockerfile` は、
> 起動を確認済みのローカル実行環境（docs/DECISIONS.md 作業W）の版を正にした。起動はリポジトリ直下の README.md の手順（`pnpm dev`）に従う。
> 下の「起動手順（モック生成器）」と、表の `compose.yaml`・`docker/migrate.ts` の行は T12 時点の案で、今の直下の `compose.yaml` とは合っていない。
> このディレクトリで今も使うのは、実Codex生成用の `docker/Dockerfile`（target `worker-codex`）、`docker/codex-sandbox/`、`docker/compose.codex.yaml`、`docker/egress-proxy/`。

## ファイル

| ファイル | 内容 |
| --- | --- |
| `compose.yaml`（リポジトリ直下） | PostgreSQL・migrate（起動時に1回）・web（3100）・worker・preview（3200）。既定はモック生成器 |
| `docker/Dockerfile` | アプリのイメージ。target：`web`・`worker`・`preview`・`worker-codex`（docker CLI 付きのworker） |
| `docker/migrate.ts` | packages/db/drizzle のマイグレーションを PostgreSQL に適用する（適用済みは飛ばす） |
| `docker/codex-sandbox/Dockerfile` | 生成用コンテナのイメージ（Node 24・Codex SDK と同梱の Codex CLI・packages/generation・Astroテンプレート） |
| `docker/compose.codex.yaml` | 実Codexで生成するときに重ねる設定（ローカルの試験用） |
| `docker/egress-proxy/` | 生成用コンテナの送信先を絞る出口プロキシ（squid）の案。未検証・未接続（下記） |
| `.dockerignore`（リポジトリ直下） | .env・reports/・node_modules 等をビルドに渡さない |

## 前提

- Docker Engine と Docker Compose v2（`docker compose`）。
- リポジトリ直下に `.env`（Gitに入れない）を作り、次を設定する。値はここにもイメージにも書かない。

  | 変数 | 用途 |
  | --- | --- |
  | `POSTGRES_USER`・`POSTGRES_PASSWORD`・`POSTGRES_DB` | DBの作成と、各サービスの `DATABASE_URL` の組み立て。パスワードはURLに埋め込むため、英数字など URL でエスケープ不要な文字にする |
  | `POSTGRES_HOST_PORT`（任意） | ホストから psql で見るときのポート。既定 54320（127.0.0.1 のみ） |
  | `WEB_PORT`・`PREVIEW_PORT`（任意） | ホスト側のポート。既定 3100・3200 |
  | `NTA_APPLICATION_ID`・`PSI_API_KEY`（任意） | worker にだけ渡す。未設定なら使わない |

  `.env` の `DATABASE_URL`（Dockerなしの開発用。127.0.0.1:54329）は compose では使わない。
  compose は `db` サービス宛ての `DATABASE_URL` を上の3つから組み立てて各サービスに渡す。
- 公開ポートはすべて 127.0.0.1 に割り当てる。外部へ公開しない（AWS公開は行わない段階）。

## 起動手順（モック生成器）

    # 1. 設定の展開結果を確認（秘密値が表示されるため、画面共有・ログ保存に注意）
    docker compose config --quiet

    # 2. ビルドと起動。db が healthy → migrate が完了 → web・worker・preview が起動する
    docker compose up -d --build

    # 3. 状態とログ
    docker compose ps
    docker compose logs migrate
    docker compose logs -f worker

    # 4. 開発用の初期ユーザー（運営1・営業1）。パスワードは実行時に表示される。再実行しても既存は変えない
    docker compose run --rm worker pnpm exec tsx packages/core/src/auth/seed.ts

マイグレーションだけを流し直すとき：`docker compose run --rm migrate`。
止める：`docker compose down`（データを消すときだけ `-v`。PostgreSQL・デモ・診断の成果物のボリュームが消える）。

## 確認項目

Dockerのある環境で、上から順に確かめる。結果は docs/DECISIONS.md の作業記録に書く（未確認の項目は未確認と書く）。

1. `docker compose config --quiet` が成功する。`.env` の変数が足りないときは、どの変数が必要かのメッセージで止まる。
2. `docker compose build` で web・worker・preview・migrate のイメージができる（`pnpm install --frozen-lockfile` と `next build` が通る）。
3. `db` が healthy になり、`docker compose logs migrate` に「適用済み」と出て終了コード 0。
   2回目の `docker compose run --rm migrate` でも成功し、二重に適用されない。
4. web：<http://localhost:3100> が開き、seed のユーザーでログインできる。
   `next start` は NODE_ENV=production のため、セッションのCookieに Secure が付く。localhost では多くのブラウザが受け付けるが、ログインできなければこの点を疑う。
5. preview：<http://localhost:3200> が応答する（トークンのないパスは 404）。web の画面から発行した提案リンクで、デモが表示される。
6. worker：ログに「ワーカーを起動した」と設定の要約（generator: mock 等）が出る。
   収集→診断→生成→デモのビルドのジョブを1件流し、デモが `demos` ボリュームに作られ、preview から見える。
   ジョブの投入方法（web の画面からキューへ送る経路の有無を含む）は apps/worker の実装に従う。この README の作成時点では確認していない。
7. worker の中で Python と Chromium が使える：`docker compose exec worker python3 --version`、`docker compose exec worker chromium --version`。
   collect.py のスクリーンショットは root でない Chromium をコンテナ内で使うため、サンドボックスの都合で失敗しうる（失敗しても診断は「スクリーンショットなし」で続く）。失敗する場合の対処は未決（下の「未解決」）。
8. 生成用コンテナでの1回の実行（次節）。

## 実Codexでの生成（ローカルの試験に限る）

**ChatGPTログインでワーカーから Codex を自動実行する使い方は、ローカルの試験に限る。**
利用条件に合うかは未確認で、本番（運営サーバー）に進む前にAPIキー方式で確認する（REQUIREMENTS.md 24.3、docs/IMPLEMENTATION_PLAN.md の注意）。

### Codexの認証の渡し方

1. ホストで Codex CLI に ChatGPT でログインし、`auth.json` を作る（既定では `~/.codex/auth.json`）。
   認証ファイルは Git・イメージ・ログ・生成物に入れない。リポジトリの外に置く。
2. `.env` に **ホスト上の絶対パス** を書く：`SITEOFFER_CODEX_AUTH_FILE=/home/<user>/.codex/auth.json`。
   パスに `:` と `,` は使えない（docker.ts が拒否する）。
3. ワーカーはこのパスを `docker run --mount type=bind,...,readonly` に渡すだけで、ワーカーのコンテナ自体には認証ファイルをマウントしない。
   Docker デーモンがホスト上でこのパスを読み、生成用コンテナの `/home/codex/.codex/auth.json` に読み取り専用で見せる。
4. 生成用コンテナは uid 1000 で動くため、`auth.json` は uid 1000 が読める必要がある（ホストのユーザーが uid 1000 でなければ、読めるコピーを用意する）。
5. 読み取り専用のため、Codex CLI がトークンを更新して書き戻すことはできない。期限が切れたらホストで再ログインする（コンテナ内で更新が必要になったときの挙動は未確認）。

### 準備

    # 生成用イメージ（compose の外でビルドする）
    docker build -f docker/codex-sandbox/Dockerfile -t siteoffer-codex-sandbox:local .

    # 送信先を絞らない試験用ネットワーク（同じネットワーク上のコンテナ同士の通信を止める）
    docker network create --driver bridge \
      --opt com.docker.network.bridge.enable_icc=false siteoffer-codex-open

    # 生成の作業ディレクトリ。ホストとワーカーのコンテナで同じ絶対パスにする。uid 1000 が書けるようにする
    sudo mkdir -p /var/lib/siteoffer/gen && sudo chown 1000:1000 /var/lib/siteoffer/gen

`.env` に追加する：

| 変数 | 例・説明 |
| --- | --- |
| `SITEOFFER_CODEX_AUTH_FILE` | ホスト上の auth.json の絶対パス（上記） |
| `SITEOFFER_CODEX_WORK_DIR` | `/var/lib/siteoffer/gen`（ホストとワーカーで同じパス。ワーカーの TMPDIR になる） |
| `DOCKER_GID` | `stat -c %g /var/run/docker.sock` の値（ワーカーがソケットを使うため） |
| `SITEOFFER_CODEX_MODEL`（任意） | 要求モデル。空なら SDK・CLI の既定。生成モデルIDは未決（REQUIREMENTS.md） |
| `SITEOFFER_CODEX_IMAGE`・`SITEOFFER_CODEX_NETWORK`（任意） | 既定は `siteoffer-codex-sandbox:local`・`siteoffer-codex-open` |

### 起動と1回の実行

    docker compose -f compose.yaml -f docker/compose.codex.yaml up -d --build

1. worker のログで `generator: codex` になっていることを確認する。
2. 1社分の生成ジョブを1回だけ流す（投入方法は上の確認項目6と同じ。同時実行は DEFAULT_GENERATION_LIMITS の上限内）。
3. 実行中に `docker ps --filter label=siteoffer.generation.job` で生成用コンテナが1つ見え、終わると消える（`--rm`）。
   `docker inspect` で、read-only・cap-drop ALL・no-new-privileges・pids/CPU/メモリの上限・マウント2つ・環境変数4つになっていることを確かめる。
4. 生成の記録（スレッドID・SDK/CLIの版・usage）が保存される。応答モデルは SDK のイベントに含まれないため不明（null）のまま。
5. 失敗したときは、生成の記録の失敗理由と worker のログを見る。作業ディレクトリは既定で削除される。

ワーカーにホストの Docker ソケットを渡すと、ワーカーはホストの root 相当の操作ができる。この構成はローカルの試験だけで使う。
ワーカーをコンテナに入れず、ホストで `pnpm --filter @siteoffer/worker start` として動かす方法でも、生成用コンテナは同じように起動できる
（その場合 `SITEOFFER_CODEX_WORK_DIR` の共有は不要）。

## 生成用コンテナの制限（docker.ts の buildDockerRunArgs との対応）

生成用イメージは、起動側の次の前提に合わせて作ってある：

- `--read-only`：`/app` は root 所有で、実行ユーザーから書けない。書けるのは `/work`（作業ディレクトリ）と tmpfs（`/tmp`・`/home/codex/.codex`）だけ。
  マウント先の `/work`・`/home/codex/.codex` はイメージ内に作ってある。
- `--user 1000:1000`：root では動かさない。`/home/codex` は uid 1000 の所有。
- `--cap-drop ALL`・`--security-opt no-new-privileges`・`--pids-limit`・`--cpus`・`--memory`（swap なし）・`--init`：イメージ側で追加の権限を必要としない。
- マウントは作業ディレクトリと読み取り専用の auth.json だけ。イメージに秘密値・アプリのDB接続情報を入れない。
- 環境変数は起動側が値を明示した4つ（`SITEOFFER_SANDBOX`・`HOME`・`CODEX_HOME`・`SITEOFFER_TIMEOUT_MS`）とイメージの既定値だけ。
  container-entry.ts は Codex CLI へさらに許可リスト（PATH・HOME・CODEX_HOME・LANG・TZ）だけを渡す。

未確認：コンテナ内で Codex 自身のサンドボックス（`sandboxMode: workspace-write`。Linux では Landlock・seccomp）が
cap-drop ALL・no-new-privileges の下で動くか。動かない場合は CodexGenerator の `sandboxMode` で切り替えられる（隔離の本体はコンテナ）。

## 生成用コンテナのネットワーク（送信先の制限）

方針：Codex CLI が必要とする先（OpenAI 等）だけへ送信できるようにする（24.4）。現状は**未実装**で、次の段階に分けている。

| 段階 | 内容 | 状態 |
| --- | --- | --- |
| 試験用 | `siteoffer-codex-open`：ICC を止めた専用ブリッジ。他のサービス（DB等）とは別ネットワークだが、インターネットへの送信先は絞らない | 手順のみ（未検証） |
| 案 | `siteoffer-codex-egress`（`internal: true`。外へ直接出られない）＋ `egress-proxy`（squid。`allowed-domains.txt` のドメインへの CONNECT 443 だけ中継）。docker/compose.codex.yaml と docker/egress-proxy/ に用意 | 未検証・未接続 |

案を使えない理由と必要な変更（担当外）：

- 生成用コンテナに `HTTPS_PROXY=http://172.30.240.2:3128` を渡す必要がある。docker.ts は値を明示した環境変数しか渡さず、
  container-entry.ts は Codex CLI へ許可リストの変数しか渡さない。プロキシの変数をイメージの ENV で入れても Codex CLI まで届かない。
  → container-entry.ts の許可リストに `HTTPS_PROXY`・`NO_PROXY` を足す（値は docker.ts の引数で明示するか、イメージの ENV に置く）変更が要る。
- Codex CLI が `HTTPS_PROXY` を使うか、ChatGPTログイン時に接続する先（`allowed-domains.txt` の値は想定）は未確認。
  プロキシのログ（`docker compose logs egress-proxy`）で接続先を確かめて許可リストを確定する。
- 別案：ホストの iptables（DOCKER-USER チェイン）で生成用ネットワークの送信先IPを絞る。宛先がCDNのIPで変わるため、ドメイン単位のプロキシより保守が難しい。

## 未解決・担当外

- Astro のビルドは、現状ワーカーのプロセス内（createAstroSiteBuilder）で行っている。24.4 は「Codexの作業とサイトのビルド」をコンテナで行うとしているため、
  ビルドも生成用コンテナ（イメージには templates/astro-site と Astro を入れてある）で行う変更が別途要る。コンテナ内のビルドで `.astro` 等をテンプレート側に書こうとすると read-only で失敗しうる（未確認）。
- CodexGenerator の作業ディレクトリは `os.tmpdir()` 配下に固定で、設定で変えられない。compose.codex.yaml では TMPDIR で向きを変えている（Python・Chromium の一時ファイルも同じ場所になる）。専用の設定値があるとよい。
- Chromium をコンテナ内の一般ユーザーで動かすと、Chromium のサンドボックスが使えず起動に失敗することがある。collect.py と templates/astro-site/check/mobile.ts は `--no-sandbox` 等を付けていない。対処（引数の追加か、seccomp の設定）は未決。
- `.env.example` に compose 用の変数（POSTGRES_* 等）が入っていない。
- ベースイメージ（`node:24-bookworm-slim`・`debian:bookworm-slim`・`docker:27.5.1-cli`）は版・ダイジェストの固定が不十分。Dockerのある環境でダイジェストに固定する。
- バックアップ・監視・ログ保管の具体値は AWS の詳細設計で決める（19章）。この compose はローカル用。
