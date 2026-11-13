#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ ! -r .env ]; then
  echo "Missing .env in $(pwd)" >&2
  exit 1
fi
docker compose exec -T gateway node /app/print-app-config.mjs
