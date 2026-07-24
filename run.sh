#!/usr/bin/env bash
# Rebuild the frontend bundle, then compile + launch the Tauri app.
# Usage: ./run.sh          # debug build
#        ./run.sh --release # release build
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$DIR/crates/workshop-tauri/frontend"

if [ ! -d "$FRONTEND/node_modules" ]; then
  echo "▸ installing frontend deps"
  if [ -f "$FRONTEND/package-lock.json" ]; then
    (cd "$FRONTEND" && npm ci)
  else
    (cd "$FRONTEND" && npm install)
  fi
fi

echo "▸ building frontend"
(cd "$FRONTEND" && npm run build)

echo "▸ launching workshop"
exec cargo run -p workshop-tauri "$@"
