#!/bin/bash
# Install step-feishu-bridge as a macOS launchd service.
# Usage: bash install-launchd.sh

set -euo pipefail

BRIDGE_ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$BRIDGE_ROOT/com.step-cli.feishu-forwarder.plist"
DST="$HOME/Library/LaunchAgents/com.step-cli.feishu-forwarder.plist"

echo "=== Install step-feishu-bridge launchd service ==="
echo "  Source: $SRC"
echo "  Destination: $DST"
echo ""

if [ ! -f "$SRC" ]; then
  echo "Error: plist template not found at $SRC"
  exit 1
fi

# Stop existing service if running
if launchctl list com.step-cli.feishu-forwarder &>/dev/null 2>&1; then
  echo "Unloading existing service..."
  launchctl unload "$DST" 2>/dev/null || true
fi

# Copy plist to user's LaunchAgents directory
mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DST"

# Load the service
echo "Loading service..."
launchctl load "$DST"

echo ""
echo "Done! Service installed as com.step-cli.feishu-forwarder"
echo "Check status: launchctl list com.step-cli.feishu-forwarder"
echo "View logs: tail -f /tmp/step-feishu-forwarder.log"
