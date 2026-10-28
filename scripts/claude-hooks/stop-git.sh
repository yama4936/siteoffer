#!/usr/bin/env bash
# Claude Code の Stop フック。
# このセッションが編集したファイル（track-edit.sh の記録）に未コミットの変更が残っているか、
# origin/main より先のローカルコミットがあれば、終了を1回止めて AGENTS.md の手順での commit・push を促す。
# 他のセッションの変更は判定に含めない。2回目の停止（stop_hook_active）は通す。
set -u
input=$(cat)
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0
session=$(printf '%s' "$input" | jq -r '.session_id // empty')

root=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0
log="$(git rev-parse --absolute-git-dir)/claude-edits/${session//[^A-Za-z0-9_-]/_}.txt"

dirty=""
if [ -n "$session" ] && [ -s "$log" ]; then
  while IFS= read -r f; do
    [ -n "$(git status --porcelain -- "$f" 2>/dev/null)" ] && dirty+="  - $f"$'\n'
  done <"$log"
fi
ahead=$(git log --oneline origin/main..HEAD 2>/dev/null)

[ -z "$dirty" ] && [ -z "$ahead" ] && exit 0

reason="AGENTS.md の「Gitへの反映（自動）」に従って、このセッションの変更を commit・push してから終了してください。"
[ -n "$dirty" ] && reason+=$'\n'"このセッションが編集した未コミットのファイル："$'\n'"$dirty"
[ -n "$ahead" ] && reason+=$'\n'"origin/main より先の未pushのコミット："$'\n'"$ahead"$'\n'
reason+=$'\n'"検証に失敗している・作業途中・他の作業の変更と混在して判断できない場合は、commit・push せずに理由をユーザーに報告して終了してよい。他のセッションの変更は add しない。"

jq -n --arg r "$reason" '{decision: "block", reason: $r}'
