# syntax=docker/dockerfile:1
#
# SiteOffer のアプリ（web・worker・preview）のイメージ。pnpm のモノレポとしてビルドする。
# ビルドのコンテキストはリポジトリのルート（compose.yaml から使う）。
#
#   docker build -f docker/Dockerfile --target web     -t siteoffer-web:local .
#   docker build -f docker/Dockerfile --target worker  -t siteoffer-worker:local .
#   docker build -f docker/Dockerfile --target preview -t siteoffer-preview:local .
#
# 状態：用意のみ。この開発環境にはDockerがなく、ビルド・起動とも未確認（docker/README.md）。
# 秘密値（DB接続・APIキー・Codex認証）はイメージに入れない。実行時に compose から環境変数で渡す。

# Node 24。再現性のため、Dockerのある環境で版（例：24.x.y）またはダイジェストに固定すること
ARG NODE_IMAGE=node:24-bookworm-slim
ARG PNPM_VERSION=12.11.2

# ---------------------------------------------------------------------------
# base：ワークスペース全体と依存（開発依存を含む。tsx・next のビルドに使う）
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV NEXT_TELEMETRY_DISABLED=1 \
    ASTRO_TELEMETRY_DISABLED=1 \
    LANG=C.UTF-8
RUN npm install -g "pnpm@${PNPM_VERSION}" && npm cache clean --force

# アプリはイメージ内の node ユーザー（uid 1000）で動かす。root では動かさない
WORKDIR /app
RUN chown node:node /app \
 && mkdir -p /data/demos /data/audit /data/gen-tmp \
 && chown -R node:node /data
USER node

# 依存の解決に要るファイルだけを先にコピーし、ソースの変更で依存の層を作り直さない
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node apps/worker/package.json apps/worker/
COPY --chown=node:node apps/preview/package.json apps/preview/
COPY --chown=node:node packages/audit/package.json packages/audit/
COPY --chown=node:node packages/core/package.json packages/core/
COPY --chown=node:node packages/db/package.json packages/db/
COPY --chown=node:node packages/discovery/package.json packages/discovery/
COPY --chown=node:node packages/generation/package.json packages/generation/
COPY --chown=node:node packages/schemas/package.json packages/schemas/
COPY --chown=node:node templates/astro-site/package.json templates/astro-site/
RUN pnpm install --frozen-lockfile

# ソース一式（.dockerignore で node_modules・.env・reports 等を除く。取得済みの node_modules は残る）
COPY --chown=node:node . .

# ---------------------------------------------------------------------------
# web：Next.js（3100番）
# ---------------------------------------------------------------------------
FROM base AS web
# ビルド時にDBへは接続しない（lib/db.ts は要求時に DATABASE_URL を読む）
RUN pnpm --filter @siteoffer/web build
ENV NODE_ENV=production
EXPOSE 3100
CMD ["pnpm", "--filter", "@siteoffer/web", "start"]

# ---------------------------------------------------------------------------
# preview：提案リンク・デモの配信（3200番。webとは別オリジン）
# マイグレーション（docker/migrate.ts）もこのイメージで実行する
# ---------------------------------------------------------------------------
FROM base AS preview
ENV NODE_ENV=production
EXPOSE 3200
CMD ["pnpm", "--filter", "@siteoffer/preview", "start"]

# ---------------------------------------------------------------------------
# worker：収集・診断・生成・デモのビルド
#  - python3：評価スキルの collect.py・score.py と提案スキルの decide.py（標準ライブラリのみ使用）を
#    packages/audit が `python3 -I` で起動するため必要
#  - chromium：collect.py のスクリーンショット（既定で有効）と、templates/astro-site のスマホ幅の検査
#    （checkDist の mobile。ワーカーの既定では無効）が /usr/bin/chromium を探すため入れる。
#    無ければ両方とも「unavailable」として続行する実装だが、診断の根拠が減るため入れておく
# ---------------------------------------------------------------------------
FROM base AS worker
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 chromium fonts-noto-cjk ca-certificates \
 && rm -rf /var/lib/apt/lists/*
USER node
ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium
CMD ["pnpm", "--filter", "@siteoffer/worker", "start"]

# ---------------------------------------------------------------------------
# worker-codex：SITEOFFER_GENERATOR=codex で、生成用コンテナを docker run するワーカー
# docker CLI だけを足す（デーモンは入れない。ホストのデーモンをソケットで使う：docker/compose.codex.yaml）
# ---------------------------------------------------------------------------
FROM docker:27.5.1-cli AS docker-cli

FROM worker AS worker-codex
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
