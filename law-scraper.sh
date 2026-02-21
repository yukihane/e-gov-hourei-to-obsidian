#!/usr/bin/env bash
set -euo pipefail

# Docker実行の定型（UID/GID引き継ぎ + compose run）を短縮するラッパー。
# 使い方:
#   ./law-scraper.sh --build-dictionary
#   ./law-scraper.sh --law-id 334AC0000000121
#   ./law-scraper.sh "特許法"
#   ./law-scraper.sh --no-build --law-id 334AC0000000121

BUILD_FLAG="--build"
if [[ "${1:-}" == "--no-build" ]]; then
  BUILD_FLAG=""
  shift
fi

if [[ "$#" -eq 0 ]]; then
  echo "usage: $0 [--no-build] <law-scraper args...>" >&2
  exit 1
fi

HOST_UID="${HOST_UID:-$(id -u)}"
HOST_GID="${HOST_GID:-$(id -g)}"

if [[ -n "$BUILD_FLAG" ]]; then
  HOST_UID="$HOST_UID" HOST_GID="$HOST_GID" docker compose run "$BUILD_FLAG" --rm law-scraper "$@"
else
  HOST_UID="$HOST_UID" HOST_GID="$HOST_GID" docker compose run --rm law-scraper "$@"
fi
