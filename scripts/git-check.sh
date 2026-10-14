#!/usr/bin/env bash
# コミット前の検査。ステージ済みの変更だけを対象にする。
# 使い方：git add <対象ファイル> したあと scripts/git-check.sh を実行し、成功したらコミットする。
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1

fail=0
staged=$(git diff --cached --name-only --diff-filter=ACMR)

if [ -z "$staged" ]; then
  echo "NG: ステージ済みの変更がありません" >&2
  exit 1
fi

# 行末の空白・競合マーカー
if ! git diff --cached --check; then
  echo "NG: 行末の空白または競合マーカーがあります" >&2
  fail=1
fi

# Gitに入れないファイル
# .env.example（値を空にした例）だけは許可する
blocked=$(printf '%s\n' "$staged" | grep -E '(^|/)(reports/|__pycache__/|\.env($|\.)|node_modules/)|\.(pem|key|pyc)$' | grep -vE '(^|/)\.env\.example$' || true)
if [ -n "$blocked" ]; then
  echo "NG: Gitに入れないファイルがステージされています：" >&2
  printf '  %s\n' $blocked >&2
  fail=1
fi

# 秘密情報の代表的なパターン（完全な検査ではない）
secret_re='(sk-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,})'
hits=$(git diff --cached -U0 | grep -E '^\+' | grep -v '^+++' | grep -nE "$secret_re" || true)
if [ -n "$hits" ]; then
  echo "NG: 秘密情報らしき文字列があります（値は表示しません）。行番号：" >&2
  printf '%s\n' "$hits" | cut -d: -f1 | tr '\n' ' ' >&2
  echo >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "OK: $(printf '%s\n' "$staged" | wc -l)件のステージ済みファイルを検査しました"
