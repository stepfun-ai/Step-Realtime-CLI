#!/bin/bash
# One-click activation: Feishu → Step event forwarding
set -e

BRIDGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_URL="${FORWARD_URL:-http://127.0.0.1:18944/forward}"

echo "=== Activate Step Feishu Event Forwarding ==="
echo ""

# 1. Ensure step serve is running
if ! curl -s http://127.0.0.1:47123/health > /dev/null 2>&1; then
  echo "Start Step serve..."
  step serve --port 47123 &
  STEP_PID=$!
  echo "  PID: $STEP_PID"
  sleep 3
else
  echo "✓ Step serve running"
fi

# 2. Start the bridge
echo "Start step-feishu-bridge..."
BRIDGE_PID=$(lsof -ti:18944 2>/dev/null || true)
if [ -n "$BRIDGE_PID" ]; then
  echo "✓ Bridge already running (PID: $BRIDGE_PID)"
else
  cd "$BRIDGE_ROOT"
  STEP_SERVE_URL=http://127.0.0.1:47123 \
  node direct_bridge.cjs &
  BRIDGE_PID=$!
  echo "  PID: $BRIDGE_PID"
  sleep 2
fi

echo ""
echo "Done! Feishu events will be forwarded to Step serve."
echo "Monitor: curl $BRIDGE_URL/health | python3 -m json.tool"
