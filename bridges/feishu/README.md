# Step-Realtime-Feishu-Bridge

A bridge service that connects **Feishu (Lark) bot** to **Step-Realtime-CLI**, enabling voice and text-driven CLI programming directly from Feishu.

## Architecture

```
Feishu user → Feishu Bot → Primary Subscriber → HTTP POST /forward
                                                  ↓
                                          step-feishu-bridge
                                                  ↓
                                         Step serve (HTTP API)
                                                  ↓
                                          Step-Realtime-CLI
```

**Two event sources supported:**
1. **Forward mode** (recommended): Events forwarded from an existing primary Feishu bot subscriber via `CODEX_FEISHU_EVENT_FORWARD_URL` or `CLAUDE_FEISHU_EVENT_FORWARD_URL`
2. **Direct mode**: Lark SDK WebSocket (requires Feishu app credentials)

## Features

- ✅ **Text messages**: Send a message → Step serve processes → Reply in Feishu
- ✅ **Voice messages**: Send a voice message → ASR (StepFun) → Text → Step serve → Reply
- ✅ **Step serve integration**: Creates sessions, sends prompts, waits for completion
- ✅ **Session persistence**: Maintains per-user sessions across messages
- ✅ **Health endpoint**: Monitor service status in real-time
- ✅ **Launchd service**: macOS native service management
- ✅ **Fire-and-forget forwarding**: Non-blocking event relay from primary subscriber

## Prerequisites

- [Step-Realtime-CLI](https://github.com/step-cli/step-realtime-cli) installed and running (`step serve --port 47123`)
- [Feishu bot](https://open.feishu.cn/app) created with event subscription enabled
- `lark-cli` configured with bot credentials
- Node.js >= 18
- A StepFun API key (for ASR/TTS voice features)

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

Copy the environment template and fill in your values:

```bash
cp .env.example .env
```

At minimum, set:
- `STEP_SERVE_URL` - Step serve endpoint (default: `http://127.0.0.1:47123`)
- `STEP_API_KEY` - Your StepFun API key (required for ASR/TTS voice)

### 3. Configure Feishu bot (choose one)

**Option A: Forward from another bot** (recommended for development)

If you already have a running Feishu bot subscriber (e.g., from Claude Code or Codex), set the forward URL environment variable in its launchd plist:

```bash
# For claude-feishu-direct
launchctl setenv CLAUDE_FEISHU_EVENT_FORWARD_URL "http://127.0.0.1:18944/forward"
# Restart the service
```

**Option B: Direct Lark SDK WebSocket**

Set Feishu app credentials in `.env`:
```
STEP_FEISHU_APP_ID=cli_xxxxxxxxxxxx
STEP_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxx
```

### 4. Start the bridge

```bash
npm start
```

### 5. Verify

```bash
curl http://127.0.0.1:18944/health
```

Expected response:
```json
{
  "ok": true,
  "service": "step-feishu-direct",
  "local": { "bind": { "port": 18944 } },
  "lastEventAt": null,
  "lastError": null
}
```

Send a message to your Feishu bot, then check the health endpoint again — `lastEventAt` should have a timestamp and `lastMessageSummary` should show the conversation.

## API

### `GET /health`

Service health and status information. Returns:
- Service metadata (bind, config, state)
- Transport state
- Last event timestamp and message summary
- Error log

### `POST /forward`

Receive forwarded Feishu events from a primary subscriber. Accepts lark-cli compact-format event JSON:

```json
{
  "type": "im.message.receive_v1",
  "message_id": "om_xxxxxxxx",
  "sender_id": "ou_xxxxxxxx",
  "chat_type": "p2p",
  "message_type": "text",
  "content": "hello"
}
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `STEP_SERVE_URL` | `http://127.0.0.1:47123` | Step serve HTTP API endpoint |
| `STEP_FEISHU_BIND_HOST` | `127.0.0.1` | Bridge HTTP server bind address |
| `STEP_FEISHU_BIND_PORT` | `18944` | Bridge HTTP server port |
| `STEP_FEISHU_CONFIG_PATH` | `~/.step-cli-feishu/config.json` | Feishu bot config file path |
| `STEP_FEISHU_STATE_DIR` | `./state` | Persistent state directory |
| `STEP_FEISHU_LARK_CLI` | `lark-cli` | lark-cli binary path |
| `STEP_FEISHU_APP_ID` | — | Feishu app ID (for SDK mode) |
| `STEP_FEISHU_APP_SECRET` | — | Feishu app secret (for SDK mode) |
| `STEP_API_KEY` | — | StepFun API key for ASR/TTS |
| `STEP_FEISHU_DOMAIN` | `feishu` | Feishu domain (`feishu` or `overseas`) |
| `LARK_CLI_NO_PROXY` | — | Set to `1` to bypass proxy for lark-cli |

## Deployment (macOS)

Install as a launchd background service:

```bash
bash scripts/install-launchd.sh
```

This will:
1. Copy the plist template to `~/Library/LaunchAgents/`
2. Update file paths to match your installation directory
3. Load the service with launchctl

## Scripts

| Script | Description |
|---|---|
| `scripts/start.sh` | Start the bridge with env setup |
| `scripts/activate.sh` | Full activation (bridge + forwarder) |
| `scripts/forward-events.sh` | lark-cli → bridge event pipe |
| `scripts/install-launchd.sh` | Install as macOS launchd service |
| `scripts/com.rsaga.step-feishu-forwarder.plist` | launchd plist template |
| `scripts/com.rsaga.step-serve.plist` | Step serve lauchd template |

## Development

```bash
# Run with file watching (auto-restart on changes)
npm run dev

# Check health
npm run health
```

## License

MIT
