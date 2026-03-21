# openclaw-claude-proxy

> **Already paying for Claude Pro/Max? Use it as your OpenClaw model provider — $0 extra API cost.**

A lightweight, zero-dependency proxy that lets [OpenClaw](https://github.com/openclaw/openclaw) agents talk to Claude through your existing subscription. One command to set up, one file to run.

## v2.0.0 — Major Upgrade

**What's new:**
- **On-demand spawning** — eliminates the pool crash loops, DEGRADED states, and stdin timeout errors from v1.x. Each request spawns a fresh `claude -p` process with stdin written immediately. No more stale workers, no more backoff spirals.
- **Session management** — multi-turn conversations use `--resume` to avoid resending full history. Reduces token waste and enables Claude Code's built-in context compression on long conversations.
- **Full tool access** — expanded default tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Agent). Configurable via `CLAUDE_ALLOWED_TOOLS` or bypass all checks with `CLAUDE_SKIP_PERMISSIONS=true`.
- **System prompt pass-through** — set `CLAUDE_SYSTEM_PROMPT` to inject context into every request.
- **MCP config support** — set `CLAUDE_MCP_CONFIG` to load MCP servers (Telegram, etc.) into claude -p calls.
- **Concurrency control** — `CLAUDE_MAX_CONCURRENT` prevents runaway process spawning (default: 5).
- **Auth health monitoring** — periodic `claude auth status` checks with status exposed on `/health`.
- **Session API** — `GET /sessions` to list, `DELETE /sessions` to clear active sessions.
- **Improved diagnostics** — `/health` endpoint shows stats, active sessions, recent errors, auth status, and full config.

**Coexistence with Claude Code interactive mode:**
OCP and Claude Code (interactive/Telegram) run on completely different paths and can coexist on the same machine without conflict:
- OCP: `localhost:3456` (HTTP) → spawns `claude -p` processes (per-request, stateless)
- CC: MCP protocol (in-process) → persistent interactive session
- No shared ports, no shared processes, no shared sessions

**Daemon advantage over CC:**
OCP runs as a system daemon (launchd/systemd) that auto-starts on boot and auto-recovers from crashes. Unlike Claude Code interactive mode, OCP does not require a terminal session to stay open — it survives disconnects, reboots, and SSH drops. Combined with OpenClaw's memory system, this means your agents never lose continuity.

## How it works

```
OpenClaw Gateway → proxy (localhost:3456) → claude -p CLI → Anthropic (via OAuth)
```

The proxy translates OpenAI-compatible `/v1/chat/completions` requests into `claude -p` CLI calls. Anthropic sees normal Claude Code usage under your subscription — no API billing, no separate key.

## Prerequisites

- **Node.js** >= 18
- **Claude CLI** installed and authenticated (`claude login`)
- **OpenClaw** installed

## Quick Start (Node.js)

```bash
git clone https://github.com/dtzp555-max/openclaw-claude-proxy.git
cd openclaw-claude-proxy

# Auto-configure OpenClaw + start proxy + install auto-start
node setup.mjs
```

That's it. The setup script will:
1. Verify Claude CLI is installed and authenticated
2. Add `claude-local` provider to `openclaw.json`
3. Add auth profiles to all agents
4. Start the proxy
5. Install auto-start on login (launchd on macOS, systemd on Linux)

Then set your preferred Claude model as default:
```bash
openclaw config set agents.defaults.model.primary "claude-local/claude-opus-4-6"
openclaw gateway restart
```

## Session Management (v2.0)

Multi-turn conversations can use sessions to avoid resending full message history on every request.

**How to enable:** Include a `session_id` or `conversation_id` field in your request body, or set the `X-Session-Id` / `X-Conversation-Id` header.

```json
{
  "model": "claude-opus-4-6",
  "session_id": "conv-abc-123",
  "messages": [
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi there!"},
    {"role": "user", "content": "What did I just say?"}
  ]
}
```

**First request** with a new session_id: all messages are sent, session is persisted via `--session-id`.
**Subsequent requests** with the same session_id: only the latest user message is sent via `--resume`, reducing token consumption.

Sessions expire after 1 hour of inactivity (configurable via `CLAUDE_SESSION_TTL`).

**API endpoints:**
- `GET /sessions` — list all active sessions
- `DELETE /sessions` — clear all sessions

## Security

- **Localhost only** — the proxy binds to `127.0.0.1` and is not exposed to the internet or your local network
- **Bearer token auth (optional)** — set `PROXY_API_KEY` to require a Bearer token on all requests (except `/health`). When unset, auth is disabled for backwards compatibility
- **No API keys for Claude** — authentication to Anthropic goes through Claude CLI's OAuth session, no Anthropic credentials are stored in the proxy
- **Auto-start via launchd/systemd** — `node setup.mjs` installs a user-level launch agent (macOS) or systemd user service (Linux) so the proxy starts automatically on login
- **Remove auto-start** at any time:

```bash
node uninstall.mjs
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
  "apiKey": "<your PROXY_API_KEY, or omit if auth disabled>",
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
| `claude-opus-4-6` | claude-opus-4-6 | Most capable, slower |
| `claude-sonnet-4-6` | claude-sonnet-4-6 | Good balance of speed/quality |
| `claude-haiku-4` | claude-haiku-4-5-20251001 | Fastest, lightweight |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Listen port |
| `CLAUDE_BIN` | *(auto-detect)* | Path to claude binary |
| `CLAUDE_TIMEOUT` | `300000` | Request timeout (ms) |
| `CLAUDE_ALLOWED_TOOLS` | `Bash,Read,...,Agent` | Comma-separated tools to pre-approve |
| `CLAUDE_SKIP_PERMISSIONS` | `false` | Set `true` to bypass all permission checks |
| `CLAUDE_SYSTEM_PROMPT` | *(empty)* | System prompt appended to all requests |
| `CLAUDE_MCP_CONFIG` | *(empty)* | Path to MCP server config JSON file |
| `CLAUDE_SESSION_TTL` | `3600000` | Session expiry in ms (default: 1 hour) |
| `CLAUDE_MAX_CONCURRENT` | `5` | Max concurrent claude processes |
| `PROXY_API_KEY` | *(unset)* | Bearer token for API authentication |

## API Endpoints

- `GET /v1/models` — List available models
- `POST /v1/chat/completions` — Chat completion (streaming + non-streaming)
- `GET /health` — Comprehensive health check (stats, sessions, auth, config)
- `GET /sessions` — List active sessions
- `DELETE /sessions` — Clear all sessions

## Authentication

The proxy supports optional Bearer token authentication via the `PROXY_API_KEY` environment variable.

**When `PROXY_API_KEY` is set**, all requests (except `GET /health`) must include a valid `Authorization: Bearer <token>` header. Requests with a missing or invalid token receive a `401 Unauthorized` response.

**When `PROXY_API_KEY` is not set**, authentication is disabled and all requests are accepted.

```bash
# Start with auth enabled
PROXY_API_KEY=my-secret-token node server.mjs
```

## Architecture: v1 vs v2

| | v1.x (pool) | v2.0 (on-demand) |
|---|---|---|
| Process lifecycle | Pre-spawn idle workers | Spawn per request |
| Crash handling | Backoff → DEGRADED → manual restart | No crash loops (no idle workers) |
| Session support | None (stateless) | --resume with session tracking |
| Tool access | 6 tools hardcoded | Configurable, expanded defaults |
| System prompt | None | CLAUDE_SYSTEM_PROMPT env |
| MCP support | None | CLAUDE_MCP_CONFIG env |
| Concurrency | Unlimited (dangerous) | CLAUDE_MAX_CONCURRENT limit |
| Auth monitoring | None | Periodic health checks |
| Diagnostics | Basic /health | Full stats, sessions, errors |

## Coexistence with Claude Code

OCP and Claude Code interactive mode (including Telegram bots) are completely independent:

| | OCP (this proxy) | CC interactive |
|---|---|---|
| Protocol | HTTP (localhost:3456) | MCP (in-process) |
| Process model | Per-request spawn | Persistent session |
| Lifecycle | Daemon (auto-start, auto-recover) | Requires terminal |
| Permission model | Pre-approved tools | Interactive prompts |
| Use case | Automated agent work | Human-in-the-loop |

Both can run on the same machine simultaneously. No shared state, no port conflicts.

## Recovery after OpenClaw upgrade

OpenClaw upgrades (`npm update -g openclaw`) **do not overwrite** the user config at `~/.openclaw/openclaw.json`. However, if the claude-local models stop working after an upgrade:

### One-command recovery

```bash
cd ~/.openclaw/projects/claude-proxy   # or wherever you cloned it
git pull                                # pull latest version
node setup.mjs                          # reconfigure OpenClaw + start proxy
openclaw gateway restart
```

## Notes

- Cost shows as $0 because billing goes through your Claude subscription
- Each request spawns a `claude -p` process; concurrent requests are capped by `CLAUDE_MAX_CONCURRENT`
- The proxy must run on the same machine as the Claude CLI (uses local OAuth)
- Session data is stored by Claude CLI on disk; session map is in-memory (lost on proxy restart)

## License

MIT
