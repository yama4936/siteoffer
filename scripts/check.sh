#!/usr/bin/env bash
# 型検査・Lint・全テスト。subagentと統合担当が同じコマンドで検証する。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "== typecheck"
pnpm -s typecheck
echo "== lint"
pnpm -s exec biome check .
echo "== test"
pnpm -s exec vitest run
echo "OK: check.sh"
