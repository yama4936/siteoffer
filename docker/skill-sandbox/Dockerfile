# syntax=docker/dockerfile:1
#
# スキル実行用のコンテナのイメージ。運営画面・定期実行から起動したスキル（.agents/skills）を、
# ワーカーの DockerSandboxRunner がジョブごとに使い捨てで起動し、Codex SDK で実行する（apps/worker/src/skills）。
# 生成用イメージ（docker/codex-sandbox/Dockerfile）に、スキルのスクリプトが使うものだけを足す。
#
#   docker build -f docker/codex-sandbox/Dockerfile -t siteoffer-codex-sandbox:local .
#   docker build -f docker/skill-sandbox/Dockerfile -t siteoffer-skill-sandbox:local .
#
# 足すもの：
#   - python3：collect.py・score.py・decide.py・check.py（標準ライブラリのみ）
#   - chromium・日本語フォント：collect.py のスクリーンショットと、site-rebuild のPC・スマホの表示確認
# 起動側の前提（read-only・cap-drop ALL・no-new-privileges・uid 1000・/tmp は tmpfs）は生成用と同じ。
# そのため Chromium は自身のサンドボックス（ユーザー名前空間）を使えず、設定・キャッシュも /tmp に置く。
# google-chrome の名前で、必要なフラグを付けて Chromium を起動する小さなラッパーを置く（collect.py が最初に探す名前）。
#
# 状態：用意のみ。この作業環境ではビルド・実行とも未確認（docker/README.md）。

ARG BASE_IMAGE=siteoffer-codex-sandbox:local
FROM ${BASE_IMAGE}

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 chromium fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && printf '#!/bin/sh\nexec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage --user-data-dir=/tmp/chromium-profile "$@"\n' \
      > /usr/local/bin/google-chrome \
 && chmod 0755 /usr/local/bin/google-chrome

USER 1000:1000
ENV CHROME_PATH=/usr/local/bin/google-chrome \
    XDG_CONFIG_HOME=/tmp/.config \
    XDG_CACHE_HOME=/tmp/.cache \
    PYTHONDONTWRITEBYTECODE=1
