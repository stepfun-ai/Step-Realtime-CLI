# Step-Realtime-Feishu-Bridge

Feishu (Lark) bot bridge for Step-Realtime-CLI — voice/text-driven CLI programming from Feishu.

> **Full documentation**: see the [PR description](https://github.com/stepfun-ai/Step-Realtime-CLI/pull/23) for architecture, configuration, and deployment guide.

## Quick Start

```bash
npm install
cp .env.example .env   # fill in your values
npm start
curl http://127.0.0.1:18944/health
```

## API

- `GET /health` — service status
- `POST /forward` — receive lark-cli events (localhost-only by default)

## Configuration

See `.env.example` for all available options. Key ones:

- `STEP_SERVE_URL` — Step serve endpoint (default `http://127.0.0.1:47123`)
- `STEP_API_KEY` — StepFun API key (required for voice/ASR)
- `STEP_FEISHU_APP_ID` / `STEP_FEISHU_APP_SECRET` — for Lark SDK direct mode
- `STEP_FEISHU_FORWARD_SECRET` — optional shared secret for `/forward` auth
- `STEP_FEISHU_STATE_DIR` — state directory (default: `./state`, contains `sessions.json` and `processed.json`)

## DM Policy

The bridge uses an **allowlist** DM policy by default. This means **nobody gets a reply** until their Feishu open_id is added to the allowlist.

To allow specific users, set `STEP_FEISHU_ALLOWED_USERS` (comma-separated open_ids) or configure via `~/.step-cli-feishu/config.json`:

```json
{
  "channels": {
    "feishu": {
      "allowFrom": ["ou_xxxxxxxxxxxxxx"]
    }
  }
}
```

Check `/health` for `policy.allowFromCount` to verify your allowlist is loaded.

## Graceful Shutdown

```bash
kill -TERM <pid>   # flushes state, then exits
```
