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

## Graceful Shutdown

```bash
kill -TERM <pid>   # flushes state, then exits
```
