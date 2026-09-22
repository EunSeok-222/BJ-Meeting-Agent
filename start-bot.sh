#!/bin/bash
# BookJob Meeting Bot - macOS/Linux launcher (start-bot.bat의 Mac/Linux 버전)
set -e
cd "$(dirname "$0")"

echo "================================================"
echo " BookJob Meeting Bot"
echo " Stop: press Ctrl+C"
echo " Auto-shutdown ~10 min after a meeting ends."
echo "================================================"
echo

if [ ! -f ".venv/bin/python" ]; then
  echo "[!] .venv not found. Run the one-time setup first: scripts/setup.md (macOS section)"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[!] node_modules not found. Running: npm install"
  npm install
  echo
fi

node index.js
