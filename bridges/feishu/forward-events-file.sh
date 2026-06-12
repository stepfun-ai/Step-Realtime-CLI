#!/usr/bin/env bash
# lark-cli file-based event forwarder
set -euo pipefail

OUT_DIR="lark-events"
BRIDGE_URL="${FORWARD_URL:-http://127.0.0.1:18944/forward}"
LARK_CLI="${LARK_CLI:-lark-cli}"

mkdir -p "$OUT_DIR"
find "$OUT_DIR" -name "*.json" -mmin +5 -delete 2>/dev/null || true

export LARK_CLI_NO_PROXY=1

echo "Starting lark-cli file-based event forwarder..."
echo "  Output dir: /tmp/$OUT_DIR"
echo "  Bridge URL: $BRIDGE_URL"

PROCESSED_DIR="$OUT_DIR/processed"
mkdir -p "$PROCESSED_DIR"

"$LARK_CLI" event +subscribe \
  --as bot \
  --event-types im.message.receive_v1 \
  --compact \
  --quiet \
  --force \
  --output-dir "$OUT_DIR" &
LARK_PID=$!
echo "Lark CLI PID: $LARK_PID"

LAST_COUNT=0
while true; do
  current_count=$(ls "$OUT_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
  if [ "$current_count" -gt "$LAST_COUNT" ]; then
    for file in $(ls -t "$OUT_DIR"/*.json 2>/dev/null); do
      basename=$(basename "$file")
      [ -f "$PROCESSED_DIR/$basename" ] && continue
      sleep 0.3
      size=$(stat -f%z "$file" 2>/dev/null || echo 0)
      [ "$size" -le 2 ] && continue
      content=$(cat "$file")
      [ -z "$content" ] && continue
      http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BRIDGE_URL" \
        -H "Content-Type: application/json" \
        -d "$content" 2>/dev/null || echo "000")
      if [ "$http_code" = "200" ]; then
        preview=$(echo "$content" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('text', d.get('message_id','?'))[:60])" 2>/dev/null || echo "$basename")
        echo "[$(date +%H:%M:%S)] forwarded: $preview"
      else
        echo "[$(date +%H:%M:%S)] forward failed (HTTP $http_code)"
      fi
      cp "$file" "$PROCESSED_DIR/$basename" 2>/dev/null || true
    done
    LAST_COUNT=$(ls "$OUT_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
  fi
  find "$PROCESSED_DIR" -name "*.json" -mmin +2 -delete 2>/dev/null || true
  sleep 1
done &

WATCH_PID=$!
echo "Watcher PID: $WATCH_PID"
echo "Running... (Ctrl+C to stop)"

cleanup() {
  echo ""; echo "Stopping..."
  kill $LARK_PID $WATCH_PID 2>/dev/null || true
  rm -rf "$PROCESSED_DIR"
  exit 0
}
trap cleanup INT TERM
wait
