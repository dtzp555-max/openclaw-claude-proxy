# openclaw-claude-proxy

> **Already paying for Claude Pro/Max? Use it as your OpenClaw model provider — $0 extra API cost.**

A lightweight, zero-dependency proxy that lets [OpenClaw](https://github.com/openclaw/openclaw) agents talk to Claude through your existing subscription. One command to set up, one file to run.

**Why?**
- **$0 API cost** — uses your Claude Pro/Max subscription, not pay-per-token API
- **Zero dependencies** — single Node.js file, no `npm install`
- **One command setup** — `node setup.mjs` handles everything
- **OpenAI-compatible** — standard `/v1/chat/completions` endpoint
- **All Claude models** — Opus 4.6, Sonnet 4.6, Haiku 4
- **Streaming support** — real-time SSE responses

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

## OpenClaw 升级后恢复

OpenClaw 升级（`npm update -g openclaw`）**不会覆盖** `~/.openclaw/openclaw.json` 用户配置。但如果 claude-local 模型不可用，按以下步骤排查：

### 快速诊断

```bash
# 1. 检查 proxy 是否运行
curl http://127.0.0.1:3456/health
# 应返回: {"status":"ok"}

# 2. 检查 Claude CLI 是否正常
claude -p "hello" --model sonnet --output-format text
# 应返回文本回复

# 3. 检查 OpenClaw 配置
cat ~/.openclaw/openclaw.json | grep -A3 claude-local
```

### 常见故障与恢复

| 症状 | 原因 | 恢复方法 |
|------|------|---------|
| Agent 不回复，proxy 无日志 | Gateway 未加载 claude-local provider | 检查 `openclaw.json` 中 `models.providers.claude-local` 配置 |
| Proxy 报 `exit 1` | Claude CLI 未登录或 token 过期 | 运行 `claude login` 重新认证 |
| `🔑 unknown` 显示 | 正常现象（无 API key，走 OAuth） | 不影响功能，可忽略 |
| `/status` 显示 Context 0% | 消息未到达 proxy（SSE 格式问题） | 确保 proxy 是最新版本，支持 streaming |
| Gateway 报 `invalid api type` | OpenClaw 新版本改了 API 类型名 | 检查 `api` 字段是否仍为有效值（如 `openai-completions`） |
| Proxy 启动但 `EADDRINUSE` | 端口 3456 被占用 | `lsof -i :3456` 找到并杀掉旧进程 |

### 一键恢复

```bash
cd ~/.openclaw/projects/claude-proxy   # 或你 clone 的位置
git pull                                # 拉取最新版本
node setup.mjs                          # 重新配置 OpenClaw + 启动 proxy
openclaw gateway restart
```

### 升级前备份（推荐）

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak
```

## Notes

- Cost shows as $0 because billing goes through your Claude subscription
- The `🔑` field in `/status` may show the dummy auth key — this is normal
- Each request spawns a `claude -p` process; concurrent requests are supported
- The proxy must run on the same machine as the Claude CLI (uses local OAuth)
- 同一个 Claude 账号可在多台机器上使用（共享用量额度）

## License

MIT
