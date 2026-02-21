#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-laws}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# 初回生成
rm -rf "$OUT_DIR"
docker compose run --rm law-scraper --law-id 334AC0000000121 --max-depth 1
cp -a "$OUT_DIR" "$TMP_DIR/first"

# 2回目生成（同入力）
docker compose run --rm law-scraper --law-id 334AC0000000121 --max-depth 1
cp -a "$OUT_DIR" "$TMP_DIR/second"

# 安定性確認
if ! diff -ru "$TMP_DIR/first" "$TMP_DIR/second"; then
  echo "E2E failed: outputs differ between runs" >&2
  exit 1
fi

echo "E2E passed: outputs are stable"
