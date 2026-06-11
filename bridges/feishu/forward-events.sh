#!/bin/bash
# Forward lark-cli events to step-feishu-bridge
# Usage: bash scripts/forward-events.sh
set -euo pipefail

BRIDGE_URL="${FORWARD_URL:-http://127.0.0.1:18944/forward}"
LARK_CLI="${LARK_CLI:-lark-cli}"

echo "Starting lark-cli event forwarder..."
echo "  Bridge URL: $BRIDGE_URL"
echo "  Lark CLI: $LARK_CLI"
echo ""

export LARK_CLI_NO_PROXY=1

"$LARK_CLI" event +subscribe \
  --as bot \
  --event-types im.message.receive_v1 \
  --compact \
  --quiet \
  --force | while IFS= read -r line; do
    if [ -n "$line" ]; then
      curl -s -X POST "$BRIDGE_URL" \
        -H "Content-Type: application/json" \
        -d "$line" > /dev/null 2>&1 || true
    fi
  done
