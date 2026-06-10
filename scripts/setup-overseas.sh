#!/usr/bin/env bash
# Overseas (api.stepfun.ai) installer for step-realtime-cli.
#
# Same as scripts/setup.sh but, after the user config has been written,
# rewrites the StepFun endpoints from the domestic site (api.stepfun.com)
# to the overseas site (api.stepfun.ai). Use this when your StepFun API
# key is provisioned on https://platform.stepfun.ai/.
#
# Usage:
#   bash scripts/setup-overseas.sh                         # standard overseas install
#   bash scripts/setup-overseas.sh --skip-chrome-install   # forwarded to setup.sh
#   bash scripts/setup-overseas.sh --skip-install
#   bash scripts/setup-overseas.sh --skip-build
#   bash scripts/setup-overseas.sh --force-config
#   bash scripts/setup-overseas.sh --uninstall
#
# Forwarded flags behave exactly as in scripts/setup.sh.
set -euo pipefail

cd "$(dirname "$0")/.."

OVERSEAS_BASE_URL="https://api.stepfun.ai/v1"
OVERSEAS_REALTIME_ENDPOINT="wss://api.stepfun.ai/v1/realtime/stateless"

bash scripts/setup.sh "$@"

USER_CONFIG="${HOME}/.step-cli/config.json"
if [[ ! -f "$USER_CONFIG" ]]; then
  printf "  \033[31m✗ %s\033[0m\n" "Expected $USER_CONFIG to exist after setup.sh; aborting overseas patch."
  exit 1
fi

printf "\n\033[1m%s\033[0m\n" "[overseas] Switching endpoints to api.stepfun.ai"

node - "$USER_CONFIG" "$OVERSEAS_BASE_URL" "$OVERSEAS_REALTIME_ENDPOINT" <<'NODE'
const fs = require("node:fs");
const [, , configPath, baseUrl, realtimeEndpoint] = process.argv;

const raw = fs.readFileSync(configPath, "utf8");
const config = JSON.parse(raw);

config.integrations ??= {};
config.integrations.modelsProxy ??= {};
config.integrations.modelsProxy.baseUrl = baseUrl;

config.voice ??= {};
config.voice.realtime ??= {};
config.voice.realtime.endpoint = realtimeEndpoint;

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`  ✓ Patched ${configPath}`);
console.log(`    integrations.modelsProxy.baseUrl = ${baseUrl}`);
console.log(`    voice.realtime.endpoint          = ${realtimeEndpoint}`);
NODE

printf "\n\033[1m%s\033[0m\n" "Overseas setup done. Reminder:"
printf "  %s\n" "1. Use an API key from https://platform.stepfun.ai/ (NOT platform.stepfun.com)."
printf "  %s\n" "2. Fill in model.apiKey and voice.realtime.apiKey in $USER_CONFIG."
printf "  %s\n" "3. Open a new shell (if PATH was just appended), then run: step voice"
