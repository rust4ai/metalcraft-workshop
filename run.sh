#!/usr/bin/env bash
# Rebuild the frontend bundle, then compile + launch the Tauri app.
# Usage: ./run.sh          # debug build
#        ./run.sh --release # release build
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "▸ building frontend"
(cd "$DIR/crates/workshop-tauri/frontend" && npm run build)

echo "▸ launching workshop"
exec cargo run -p workshop-tauri "$@"
