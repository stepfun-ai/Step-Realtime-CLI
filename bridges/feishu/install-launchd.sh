#!/bin/bash
# Install step-feishu-bridge as a macOS launchd service.
# Usage: bash scripts/install-launchd.sh

set -euo pipefail

BRIDGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$BRIDGE_ROOT/scripts/com.rsaga.step-feishu-forwarder.plist"
DST="$HOME/Library/LaunchAgents/com.rsaga.step-feishu-forwarder.plist"

echo "=== Install step-feishu-bridge launchd service ==="
echo "  Source: $SRC"
echo "  Destination: $DST"
echo ""

if [ ! -f "$SRC" ]; then
  echo "Error: plist template not found at $SRC"
  exit 1
fi

# Stop existing service if running
if launchctl list com.rsaga.step-feishu-forwarder &>/dev/null 2>&1; then
  echo "Unloading existing service..."
  launchctl unload "$DST" 2>/dev/null || true
fi

# Copy plist to user's LaunchAgents directory
mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DST"

# Update paths in plist to match actual BRIDGE_ROOT
sed -i '' "s|/path/to/step-realtime-feishu-bridge|$BRIDGE_ROOT|g" "$DST"

# Load the service
echo "Loading service..."
launchctl load "$DST"

echo ""
echo "Done! Service installed as com.rsaga.step-feishu-forwarder"
echo "Check status: launchctl list com.rsaga.step-feishu-forwarder"
echo "View logs: tail -f $BRIDGE_ROOT/logs/forwarder.out.log"
