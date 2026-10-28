#!/usr/bin/env bash
# Claude Code の PostToolUse（Write/Edit/NotebookEdit）フック。
# セッションが編集したファイルを .git/claude-edits/<session_id>.txt に記録し、
# 終了時（stop-git.sh）にそのセッション自身の未コミット変更だけを判定できるようにする。
set -u
input=$(cat)
session=$(printf '%s' "$input" | jq -r '.session_id // empty')
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // .tool_response.filePath // empty')
[ -n "$session" ] && [ -n "$file" ] || exit 0

root=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel 2>/dev/null) || exit 0
case "$file" in
  "$root"/*) rel=${file#"$root"/} ;;
  /*) exit 0 ;; # リポジトリ外（scratchpad 等）は対象外
  *) rel=$file ;;
esac

dir="$(git -C "$root" rev-parse --absolute-git-dir)/claude-edits"
mkdir -p "$dir"
log="$dir/${session//[^A-Za-z0-9_-]/_}.txt"
grep -qxF -- "$rel" "$log" 2>/dev/null || printf '%s\n' "$rel" >>"$log"
exit 0
