#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo ""
echo "  ⚡ Electron Forge GUI"
echo "  ─────────────────────"

if [ ! -d "node_modules" ]; then
  echo "  Installing dependencies..."
  npm install
fi

echo "  Starting server..."
echo ""
node server.js
