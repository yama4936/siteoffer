#!/usr/bin/env bash
# このマシンのデモを Cloudflare の名前付きトンネルで常時公開し、origin/main の更新を自動で反映する。
# 手順は deploy/cloudflare/README.md。
#
#   scripts/public-demo.sh init                 設定ファイルの雛形を作る（~/.config/siteoffer-public/public.env）
#   scripts/public-demo.sh setup [--copy-data]  公開専用クローンとトンネル設定を作る。--copy-data は
#                                               このリポジトリの .data/demo と reports/ を複製してパスを付け替える
#   scripts/public-demo.sh start | stop | status
#   scripts/public-demo.sh run                  （start が tmux の中で動かす）監視・反映のループ
#
# 公開専用クローンは自動で書き換えるので、そこで作業しない。作業リポジトリには触れない。
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${SITEOFFER_PUBLIC_CONFIG_DIR:-$HOME/.config/siteoffer-public}"
CONFIG="$CONFIG_DIR/public.env"
STATE_DIR="${SITEOFFER_PUBLIC_STATE_DIR:-$HOME/.local/state/siteoffer-public}"
SESSION=siteoffer-public

log() { printf '%s [public-demo] %s\n' "$(date '+%F %T')" "$*"; }
die() { log "NG: $*" >&2; exit 1; }

load_config() {
  [ -f "$CONFIG" ] || die "$CONFIG がありません。scripts/public-demo.sh init を実行してください"
  # shellcheck disable=SC1090
  . "$CONFIG"
  : "${SITEOFFER_PUBLIC_WEB_HOST:?public.env に SITEOFFER_PUBLIC_WEB_HOST を設定してください}"
  : "${SITEOFFER_PUBLIC_PREVIEW_HOST:?public.env に SITEOFFER_PUBLIC_PREVIEW_HOST を設定してください}"
  SITEOFFER_PUBLIC_DIR="${SITEOFFER_PUBLIC_DIR:-$HOME/siteoffer-demo}"
  SITEOFFER_PUBLIC_TUNNEL="${SITEOFFER_PUBLIC_TUNNEL:-siteoffer-demo}"
  SITEOFFER_PUBLIC_INTERVAL="${SITEOFFER_PUBLIC_INTERVAL:-300}"
  SITEOFFER_PUBLIC_BRANCH="${SITEOFFER_PUBLIC_BRANCH:-main}"
  export DEMO_DB_PORT="${DEMO_DB_PORT:-54339}" DEMO_WEB_PORT="${DEMO_WEB_PORT:-3110}" DEMO_PREVIEW_PORT="${DEMO_PREVIEW_PORT:-3210}"
  case "$SITEOFFER_PUBLIC_INTERVAL" in '' | *[!0-9]*) die "SITEOFFER_PUBLIC_INTERVAL は秒数で指定してください" ;; esac
  [ "$SITEOFFER_PUBLIC_INTERVAL" -ge 60 ] || die "SITEOFFER_PUBLIC_INTERVAL は60秒以上にしてください"
  [ "$(realpath -m "$SITEOFFER_PUBLIC_DIR")" != "$SOURCE_ROOT" ] || die "公開専用クローンに作業リポジトリを指定しないでください"
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

cmd_init() {
  mkdir -p "$CONFIG_DIR" "$STATE_DIR"
  chmod 700 "$CONFIG_DIR"
  if [ -f "$CONFIG" ]; then log "$CONFIG は作成済み"; return; fi
  umask 077
  cat >"$CONFIG" <<'EOF'
# SiteOffer 公開デモの設定（Gitに入れない）。値を埋めてから setup を実行する。
# Cloudflareで管理しているドメインのホスト名（https:// は付けない）
SITEOFFER_PUBLIC_WEB_HOST=
SITEOFFER_PUBLIC_PREVIEW_HOST=
# cloudflared tunnel create で作ったトンネルの名前
SITEOFFER_PUBLIC_TUNNEL=siteoffer-demo
# 公開専用クローンの場所（作業リポジトリとは別にする）
SITEOFFER_PUBLIC_DIR=$HOME/siteoffer-demo
# origin を確認する間隔（秒、60以上）と、反映するブランチ
SITEOFFER_PUBLIC_INTERVAL=300
SITEOFFER_PUBLIC_BRANCH=main
# 手元で動かす通常のデモ（54329・3100・3200）とぶつからないポート
DEMO_DB_PORT=54339
DEMO_WEB_PORT=3110
DEMO_PREVIEW_PORT=3210
EOF
  log "$CONFIG を作成した。ホスト名を埋めてから scripts/public-demo.sh setup を実行する"
}

cmd_setup() {
  local copy_data=0
  [ "${1:-}" = "--copy-data" ] && copy_data=1
  load_config
  mkdir -p "$STATE_DIR"
  local dir="$SITEOFFER_PUBLIC_DIR"

  if [ ! -d "$dir/.git" ]; then
    local url
    url="$(git -C "$SOURCE_ROOT" remote get-url origin)"
    log "公開専用クローンを作成：$dir（$url）"
    git clone --quiet --branch "$SITEOFFER_PUBLIC_BRANCH" "$url" "$dir"
  else
    log "公開専用クローンは作成済み：$dir"
  fi

  if [ "$copy_data" = 1 ]; then
    [ -d "$SOURCE_ROOT/.data/demo/pglite" ] || die "$SOURCE_ROOT/.data/demo にデモのDBがありません"
    [ ! -e "$dir/.data/demo" ] || die "$dir/.data/demo は既にあります。上書きしません（作り直すときは公開を止めて手で退避してください）"
    # 稼働中・異常終了のまま（利用記録あり）のDBは複製しない
    [ ! -e "$SOURCE_ROOT/.data/demo/runtime-owner.json" ] ||
      die "作業リポジトリのデモが動いているか、終了記録が残っています。pnpm demo:stop（必要なら demo:unlock）のあとで複製してください"
    log "デモのデータと reports/ を複製（実在企業の評価・提案を含む。Gitには入らない）"
    mkdir -p "$dir/.data"
    cp -a "$SOURCE_ROOT/.data/demo" "$dir/.data/demo"
    if [ -d "$SOURCE_ROOT/reports" ] && [ ! -e "$dir/reports" ]; then cp -a "$SOURCE_ROOT/reports" "$dir/reports"; fi
    (cd "$dir" && pnpm install --frozen-lockfile --silent && node --import tsx demo/rebase-paths.ts "$SOURCE_ROOT")
  fi

  write_tunnel_config
  log "準備完了。scripts/public-demo.sh start で公開を始める"
}

write_tunnel_config() {
  command -v cloudflared >/dev/null || die "cloudflared がありません"
  [ -f "$HOME/.cloudflared/cert.pem" ] || die "cloudflared tunnel login でCloudflareにログインしてください"
  local id
  id="$(cloudflared tunnel list --name "$SITEOFFER_PUBLIC_TUNNEL" --output json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s||"[]");process.stdout.write(t.length===1?t[0].id:"")})')"
  [ -n "$id" ] || die "トンネル $SITEOFFER_PUBLIC_TUNNEL が見つかりません。cloudflared tunnel create $SITEOFFER_PUBLIC_TUNNEL を実行してください"
  [ -f "$HOME/.cloudflared/$id.json" ] || die "トンネルの認証ファイル ~/.cloudflared/$id.json がありません（トンネルを作ったマシンで実行してください）"
  umask 077
  cat >"$CONFIG_DIR/cloudflared.yml" <<EOF
# scripts/public-demo.sh setup が生成（手で編集しない）
tunnel: $id
credentials-file: $HOME/.cloudflared/$id.json
ingress:
  - hostname: $SITEOFFER_PUBLIC_WEB_HOST
    service: http://127.0.0.1:$DEMO_WEB_PORT
  - hostname: $SITEOFFER_PUBLIC_PREVIEW_HOST
    service: http://127.0.0.1:$DEMO_PREVIEW_PORT
  - service: http_status:404
EOF
  log "トンネル設定を作成：$CONFIG_DIR/cloudflared.yml（DNSの割り当ては README の手順で行う）"
}

cmd_start() {
  load_config
  [ -f "$CONFIG_DIR/cloudflared.yml" ] || die "先に scripts/public-demo.sh setup を実行してください"
  [ -d "$SITEOFFER_PUBLIC_DIR/.git" ] || die "公開専用クローンがありません。setup を実行してください"
  if tmux has-session -t "$SESSION" 2>/dev/null; then log "既に動いています（tmux attach -t $SESSION）"; return; fi
  mkdir -p "$STATE_DIR"
  # ログはファイルへ直接書く（tee を挟むと、停止の途中で出力先が先に消えて後始末が止まるため）
  tmux new-session -d -s "$SESSION" -n deploy \
    "exec '$SOURCE_ROOT/scripts/public-demo.sh' run >>'$STATE_DIR/deploy.log' 2>&1"
  tmux new-window -t "$SESSION" -n tunnel \
    "echo \$\$ >'$STATE_DIR/tunnel.pid'; exec cloudflared tunnel --no-autoupdate --config '$CONFIG_DIR/cloudflared.yml' run >>'$STATE_DIR/tunnel.log' 2>&1"
  log "開始した。https://$SITEOFFER_PUBLIC_WEB_HOST/login （ログは $STATE_DIR/deploy.log・tunnel.log）"
}

# pid ファイルのプロセスに TERM を送り、最大 $2 秒待つ
term_wait() {
  local pid
  pid="$(cat "$1" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 "$2"); do kill -0 "$pid" 2>/dev/null || return 0; sleep 1; done
  log "pid $pid が $2 秒で止まらなかった"
  return 1
}

cmd_stop() {
  # 先にトンネルを閉じて外から見えなくし、そのあとデモを正常停止させる（ビルド中ならビルドの終了を待つ）
  term_wait "$STATE_DIR/tunnel.pid" 30 || true
  term_wait "$STATE_DIR/run.pid" 900 || true
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -f "$STATE_DIR/tunnel.pid" "$STATE_DIR/run.pid"
  log "停止した"
}

cmd_status() {
  load_config
  if tmux has-session -t "$SESSION" 2>/dev/null; then log "tmux：動作中（$SESSION）"; else log "tmux：停止"; fi
  [ -f "$STATE_DIR/deployed" ] && log "反映済みのコミット：$(cat "$STATE_DIR/deployed")"
  [ -f "$STATE_DIR/failed" ] && log "反映に失敗したコミット（再試行しない）：$(cat "$STATE_DIR/failed")"
  if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$DEMO_WEB_PORT/login"; then log "web：応答あり"; else log "web：応答なし"; fi
  if curl -fsS -o /dev/null --max-time 10 "https://$SITEOFFER_PUBLIC_WEB_HOST/login"; then log "公開URL：応答あり"; else log "公開URL：応答なし"; fi
}

# ---------- run（監視・反映のループ） ----------

DEMO_PID=""

build_at() {
  local sha="$1"
  git -C "$SITEOFFER_PUBLIC_DIR" checkout --quiet --detach "$sha" &&
    (cd "$SITEOFFER_PUBLIC_DIR" && pnpm install --frozen-lockfile --silent && pnpm --filter @siteoffer/web build)
}

start_demo() {
  local mode=()
  [ -d "$SITEOFFER_PUBLIC_DIR/.data/demo/pglite" ] && mode=(--resume)
  log "デモを起動（${mode[*]:-初回。初期データを投入}）"
  (
    cd "$SITEOFFER_PUBLIC_DIR"
    export DEMO_WEB_PROD=1
    export WEB_BASE_URL="https://$SITEOFFER_PUBLIC_WEB_HOST"
    export DEMO_PUBLIC_PREVIEW_URL="https://$SITEOFFER_PUBLIC_PREVIEW_HOST"
    export PREVIEW_FRAME_ANCESTORS="'self' https://$SITEOFFER_PUBLIC_WEB_HOST"
    exec node --import tsx demo/run.ts "${mode[@]}"
  ) &
  DEMO_PID=$!
  for _ in $(seq 1 180); do
    if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$DEMO_WEB_PORT/login"; then
      log "web が応答した"
      return 0
    fi
    kill -0 "$DEMO_PID" 2>/dev/null || break
    sleep 1
  done
  log "web が応答しない"
  stop_demo
  return 1
}

stop_demo() {
  [ -n "$DEMO_PID" ] || return 0
  if kill -0 "$DEMO_PID" 2>/dev/null; then
    log "デモを停止"
    kill -TERM "$DEMO_PID" 2>/dev/null || true
    for _ in $(seq 1 90); do kill -0 "$DEMO_PID" 2>/dev/null || break; sleep 1; done
    kill -0 "$DEMO_PID" 2>/dev/null && log "デモが90秒で止まらなかった。pnpm demo:stop・demo:unlock の確認が必要"
  fi
  wait "$DEMO_PID" 2>/dev/null || true
  DEMO_PID=""
}

# sha を反映する。失敗したら prev に戻す
deploy() {
  local sha="$1" prev="$2"
  log "反映：${prev:0:7} → ${sha:0:7}"
  stop_demo
  if build_at "$sha" && start_demo; then
    echo "$sha" >"$STATE_DIR/deployed"
    rm -f "$STATE_DIR/failed"
    log "反映した：${sha:0:7}"
    return 0
  fi
  echo "$sha" >"$STATE_DIR/failed"
  log "NG: ${sha:0:7} の反映に失敗。${prev:0:7} に戻す"
  if [ -n "$prev" ] && build_at "$prev" && start_demo; then
    log "${prev:0:7} で再開した"
  else
    log "NG: 前の版でも起動できなかった。手で確認してください"
  fi
  return 1
}

cmd_run() {
  load_config
  mkdir -p "$STATE_DIR"
  exec 9>"$STATE_DIR/run.lock"
  flock -n 9 || die "別の run が動いています"
  echo $$ >"$STATE_DIR/run.pid"
  local dir="$SITEOFFER_PUBLIC_DIR" ref="origin/$SITEOFFER_PUBLIC_BRANCH"
  trap 'stop_demo; rm -f "$STATE_DIR/run.pid"; log "終了"; exit 0' INT TERM

  git -C "$dir" fetch --quiet origin "$SITEOFFER_PUBLIC_BRANCH"
  local target deployed
  target="$(git -C "$dir" rev-parse "$ref")"
  deployed="$(cat "$STATE_DIR/deployed" 2>/dev/null || true)"
  if [ "$deployed" = "$target" ] && [ -d "$dir/apps/web/.next" ] && [ "$(git -C "$dir" rev-parse HEAD)" = "$target" ]; then
    start_demo || log "NG: 起動できなかった。次の確認で再試行する"
  else
    deploy "$target" "$deployed" || true
  fi

  while true; do
    sleep "$SITEOFFER_PUBLIC_INTERVAL" &
    wait $! || true
    if [ -z "$DEMO_PID" ] || ! kill -0 "$DEMO_PID" 2>/dev/null; then
      log "デモが止まっている。再起動する"
      DEMO_PID=""
      start_demo || true
    fi
    if ! git -C "$dir" fetch --quiet origin "$SITEOFFER_PUBLIC_BRANCH"; then
      log "origin を取得できなかった。次の確認で再試行する"
      continue
    fi
    target="$(git -C "$dir" rev-parse "$ref")"
    deployed="$(cat "$STATE_DIR/deployed" 2>/dev/null || true)"
    [ "$target" = "$deployed" ] && continue
    [ "$target" = "$(cat "$STATE_DIR/failed" 2>/dev/null || true)" ] && continue
    deploy "$target" "$deployed" || true
  done
}

case "${1:-}" in
  init) cmd_init ;;
  setup) shift; cmd_setup "$@" ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  run) cmd_run ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
