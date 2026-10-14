# syntax=docker/dockerfile:1
#
# 生成用コンテナのイメージ（REQUIREMENTS 24.4）。ジョブごとに DockerSandboxRunner が使い捨てで起動する。
# ビルドのコンテキストはリポジトリのルート。
#
#   docker build -f docker/codex-sandbox/Dockerfile -t siteoffer-codex-sandbox:local .
#
# 中身：Node 24・Codex SDK（@openai/codex-sdk）と同梱の Codex CLI（@openai/codex のプラットフォーム別バイナリ）・
#       packages/generation（エントリ container-entry.ts）と、その依存（templates/astro-site と Astro を含む）。
# 秘密値・Codex認証はイメージに入れない。認証（auth.json）は実行時に読み取り専用でマウントされる。
#
# 起動側（packages/generation/src/sandbox/docker.ts の buildDockerRunArgs）が前提にしていること：
#   --read-only / --cap-drop ALL / --security-opt no-new-privileges / --user 1000:1000
#   --pids-limit・--cpus・--memory（swapなし）・--init
#   --tmpfs /tmp（noexec）・--tmpfs /home/codex/.codex
#   マウントは /work（このジョブの作業ディレクトリ）と /home/codex/.codex/auth.json（読み取り専用）だけ
#   環境変数は SITEOFFER_SANDBOX=1・HOME=/home/codex・CODEX_HOME=/home/codex/.codex・SITEOFFER_TIMEOUT_MS だけ
#   コマンドは node /app/packages/generation/src/sandbox/container-entry.ts
# このイメージはそれに合わせ、/app を読み取りだけで動くように作り、マウント先のディレクトリを用意しておく。
#
# 状態：用意のみ。この開発環境にはDockerがなく、ビルド・実行とも未確認（docker/README.md）。

# Node 24。再現性のため、Dockerのある環境で版またはダイジェストに固定すること
ARG NODE_IMAGE=node:24-bookworm-slim
ARG PNPM_VERSION=12.11.2

# ---------------------------------------------------------------------------
# deps：generation とその依存だけを本番依存として入れる
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
RUN npm install -g "pnpm@${PNPM_VERSION}" && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# ロックファイルとワークスペースの一致確認のため、全パッケージの package.json を置く（ソースは下で必要な分だけ）
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/preview/package.json apps/preview/
COPY packages/audit/package.json packages/audit/
COPY packages/discovery/package.json packages/discovery/
COPY packages/generation/package.json packages/generation/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/schemas/package.json packages/schemas/
COPY templates/astro-site/package.json templates/astro-site/
# 「@siteoffer/generation...」は generation と、その依存のワークスペース（core・db・schemas・astro-site）
RUN pnpm install --frozen-lockfile --prod --filter "@siteoffer/generation..." \
 && rm -rf apps packages/audit packages/discovery

COPY packages/generation packages/generation
COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/schemas packages/schemas
COPY templates/astro-site templates/astro-site
# テスト・フィクスチャはコンテナ内で使わない
RUN rm -rf packages/*/test templates/astro-site/test templates/astro-site/fixtures

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV LANG=C.UTF-8 \
    ASTRO_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
# ca-certificates：OpenAI 等への HTTPS 接続に使う。それ以外のツールは入れない
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# /app は root 所有・読み取りのみ（生成中のCodexがアプリのコードを書き換えられないようにする）
COPY --from=deps /app /app

# 実行ユーザーは uid:gid 1000:1000（node イメージの node ユーザー）。HOME は起動側が /home/codex を指定する。
# 読み取り専用のルートでもマウントできるよう、マウント先を作っておく
RUN mkdir -p /home/codex/.codex /work \
 && chown -R 1000:1000 /home/codex /work \
 && chmod 0700 /home/codex/.codex

USER 1000:1000
WORKDIR /work
ENV HOME=/home/codex \
    CODEX_HOME=/home/codex/.codex
# 起動側（docker run）がコマンドを明示する。単体で起動しても SITEOFFER_SANDBOX=1 がなければ何もせず終了する
CMD ["node", "/app/packages/generation/src/sandbox/container-entry.ts"]
