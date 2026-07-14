#!/bin/bash
# step-realtime-feishu-bridge startup script
# Usage: bash start.sh
set -euo pipefail

BRIDGE_ROOT="$(cd "$(dirname "$0")" && pwd)"

# Feishu app credentials (via env vars)
APP_ID="${STEP_FEISHU_APP_ID:-}"
APP_SECRET="${STEP_FEISHU_APP_SECRET:-}"

if [ -z "$APP_ID" ] || [ -z "$APP_SECRET" ]; then
  echo "Warning: STEP_FEISHU_APP_ID and STEP_FEISHU_APP_SECRET not set."
  echo "Bridge will start in forward-only mode (no direct WebSocket)."
  echo ""
  echo "Set them via environment:"
  echo "  export STEP_FEISHU_APP_ID=cli_xxxxx"
  echo "  export STEP_FEISHU_APP_SECRET=xxxxx"
  echo ""
fi

export STEP_FEISHU_APP_ID="${APP_ID}"
export STEP_FEISHU_APP_SECRET="${APP_SECRET}"
export STEP_SERVE_URL="${STEP_SERVE_URL:-http://127.0.0.1:47123}"
export LARK_CLI_NO_PROXY=1

echo "Starting step-feishu-bridge..."
echo "  Root: $BRIDGE_ROOT"
echo "  Step serve: $STEP_SERVE_URL"
echo "  App ID: ${APP_ID:0:8}..."
echo ""

cd "$BRIDGE_ROOT"
node direct_bridge.cjs
