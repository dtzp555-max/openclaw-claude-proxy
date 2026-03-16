# openclaw-claude-proxy

Use your Claude Pro/Max subscription as an OpenClaw model provider — no API key needed.

## How it works

```
OpenClaw Gateway → proxy (localhost:3456) → claude -p CLI → Anthropic (via OAuth)
```

The proxy translates OpenAI-compatible `/v1/chat/completions` requests into `claude -p` CLI calls. Anthropic sees normal Claude Code usage under your subscription — no API billing, no separate key.

## Prerequisites

- **Node.js** ≥ 18
- **Claude CLI** installed and authenticated (`claude login`)
- **OpenClaw** installed

## Quick Install

```bash
# Clone
git clone https://github.com/dtzp555-max/openclaw-claude-proxy.git
cd openclaw-claude-proxy

# Auto-configure OpenClaw + start proxy
node setup.mjs
```

That's it. The setup script will:
1. Verify Claude CLI is installed and authenticated
2. Add `claude-local` provider to `openclaw.json`
3. Add auth profiles to all agents
4. Start the proxy

Then set your preferred Claude model as default:
```bash
openclaw config set agents.defaults.model.primary "claude-local/claude-opus-4-6"
openclaw gateway restart
```

## Manual Install

### 1. Start the proxy

```bash
node server.mjs
# or in background:
bash start.sh
```

### 2. Configure OpenClaw

Add to `~/.openclaw/openclaw.json` under `models.providers`:

```json
"claude-local": {
  "baseUrl": "http://127.0.0.1:3456/v1",
  "api": "openai-completions",
  "authHeader": false,
  "models": [
    {
      "id": "claude-opus-4-6",
      "name": "Claude Opus 4.6",
      "reasoning": true,
      "input": ["text"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 200000,
      "maxTokens": 16384
    },
    {
      "id": "claude-sonnet-4-6",
      "name": "Claude Sonnet 4.6",
      "reasoning": true,
      "input": ["text"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 200000,
      "maxTokens": 16384
    },
    {
      "id": "claude-haiku-4",
      "name": "Claude Haiku 4",
      "reasoning": false,
      "input": ["text"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 200000,
      "maxTokens": 8192
    }
  ]
}
```

### 3. Set as default model

```bash
openclaw config set agents.defaults.model.primary "claude-local/claude-opus-4-6"
openclaw gateway restart
```

## Available Models

| Model ID | Claude CLI model | Notes |
|----------|-----------------|-------|
| `claude-opus-4-6` | opus | Most capable, slower |
| `claude-sonnet-4-6` | sonnet | Good balance of speed/quality |
| `claude-haiku-4` | haiku | Fastest, lightweight |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Listen port |
| `CLAUDE_BIN` | `claude` | Path to claude binary |
| `CLAUDE_TIMEOUT` | `120000` | Request timeout (ms) |

## API Endpoints

- `GET /v1/models` — List available models
- `POST /v1/chat/completions` — Chat completion (streaming + non-streaming)
- `GET /health` — Health check

## Auto-start on Login (macOS)

Add to your `~/.zshrc`:
```bash
bash ~/.openclaw/projects/claude-proxy/start.sh 2>/dev/null
```

## Notes

- Cost shows as $0 because billing goes through your Claude subscription
- The `🔑` field in `/status` may show the dummy auth key — this is normal
- Each request spawns a `claude -p` process; concurrent requests are supported
- The proxy must run on the same machine as the Claude CLI (uses local OAuth)

## License

MIT
