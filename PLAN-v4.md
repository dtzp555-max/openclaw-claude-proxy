# OCP v4.0 开发计划 — Agent 成本控制器

## 背景

OCP 当前架构：`Tool → OCP (localhost:3456) → Claude CLI → Anthropic`

核心风险：Claude CLI proxy 属于灰色地带，Anthropic 随时可能封堵。

核心资产（不依赖 CLI 的部分）：
- OpenAI 兼容 API 层
- Session 管理（会话隔离、TTL、复用）
- Usage 监控（plan limits、per-model stats、实时查询）
- 运行时调参（timeout、并发、prompt 限制）
- `/ocp` 命令集（Telegram/Discord/CLI）
- 多实例并发控制

## 定位

> OCP is a cost-control and model-routing layer for AI agents, optimized for subscription-based usage.

**不是 proxy，不是 gateway，不是 LiteLLM clone。**
**是：让 Agent 用模型这件事变得可控 — 尤其是成本。**

核心差异点：OCP 有 agent 上下文，知道是谁在请求、在做什么任务、已经花了多少。LiteLLM 只看到 HTTP 请求。

## 目标

将 OCP 从 "Claude CLI proxy" 重构为 "Agent 成本控制器"，支持可扩展的多后端，保留全部管理能力。

---

## ⚠️ 第零原则：不动现有功能

OCP 作为 Claude CLI proxy 是当前的核心价值和用户吸引力。所有 v4 重构必须遵守：

- **外部 API 不变** — `/v1/chat/completions`、`/usage`、`/health`、`/settings` 签名不变
- **行为不变** — 现有用户升级后零感知，所有 session/timeout/并发逻辑保持原样
- **逐步替换** — 先抽模块，跑稳了再切；任何时候回归测试不过就回滚
- **新 backend 是增量** — 加 OpenAI/Ollama 是新能力，不改动 Claude CLI 路径

Phase 1 的定义就是：**拆完之后跟没拆一样。** 拆出问题就说明拆法有误。

---

## 架构关键决策（三轮 Design Review 定稿）

### 决策 1: 路由分两层 — Model Registry + Agent Policy

**三轮讨论结论：**
- 第一轮建议"删掉 model routing" → 错误，非 agent 客户端（Cline/Aider）只带 model 名
- 反驳：model-to-backend mapping 是基础设施，不是 routing rule
- 校准：物理拆成两个模块，不要混在一起

**最终设计 — 两层分离：**

```
🧱 Layer 1: Model Registry（基础设施层）
   model-registry.mjs
   静态映射，无条件，必须存在
   "claude-sonnet-4-6" → claude-cli backend
   "gpt-4o" → openai backend
   "qwen3" → ollama backend

🧠 Layer 2: Agent Policy（策略层）
   agent-router.mjs
   动态决策，可覆盖，可选
   agent "coder" → override to claude-cli
   agent "interpreter" → override to ollama
```

**路由决策顺序（写死）：**
```
1. Agent policy override  → 有 agent identity 且有配置？用它
2. Model registry         → 模型属于哪个 backend？路由过去
3. Default backend        → 都没匹配？全局默认
4. Fallback chain         → 上面选的挂了？降级
```

### 决策 2: 统一 Streaming 协议

**所有 adapter 必须输出统一的内部 chunk 格式：**

```javascript
{
  type: "delta" | "done" | "error",
  content?: string,
  model: string,
  backend: string,
  usage?: { promptTokens: number, completionTokens: number }
}
```

server.mjs 只处理统一协议 → 转换为 OpenAI SSE 输出。

### 决策 3: 成本标记 — actual / estimated / free

```javascript
{
  cost: {
    value: 0.23,
    type: "actual" | "estimated" | "free"
  }
}
```

| Backend | cost type | 来源 |
|---------|-----------|------|
| OpenAI API | actual | API 返回 usage |
| Claude CLI | estimated | prompt chars × 估价 |
| Ollama | free | 本地运行 |

`/ocp cost` 输出明确标注类型，不误导用户。

### 决策 4: Fallback — 只在 First-Byte 前触发

```javascript
const allowFallback = !hasStartedStreaming;
```

Phase 3 严格限制：已输出 ≥1 个 delta → 不 fallback，直接报错。
flag 预留，未来扩展 streaming fallback 只改判断条件。

### 决策 5: Agent Identity — 结构预留，实现从简

**优先级：**
```
1. x-ocp-agent header       → OpenClaw 自动附加
2. Session metadata          → 首次请求绑定，后续复用
3. (future) Inferred         → 按使用模式推断（预留接口）
4. default                   → 兜底
```

**现在只实现 1 + 2 + 4。** 但接口预留 inferred 扩展点。

为什么重要：未来 Cline coding mode 和 chat mode 可能需要不同路由，如果没有 identity hook 以后很难加。

---

## Backend Adapter 设计

### 接口

```javascript
class BackendAdapter {
  get id()            // "claude-cli" | "openai-api" | "ollama"
  get displayName()
  get models()
  get costType()      // "actual" | "estimated" | "free"
  get tier()          // "core" | "community"

  async healthCheck() → { ok, message, latencyMs }
  async *chatCompletion(request) → AsyncGenerator<UnifiedChunk>
  async initialize(config)
  async shutdown()
}
```

### Backend Tier 体系

OCP provides a pluggable backend adapter interface. Core adapters are maintained officially; community adapters are contributed by users.

```
/ocp backends 输出示例：

claude-cli   ✓ healthy  12ms   (core)
openai       ✓ healthy  89ms   (core)
ollama       ✓ healthy   5ms   (core)
deepseek     ✓ healthy 120ms   (community)
```

架构不限制 backend 数量。我们主动维护 3 个 core adapter（Claude CLI、OpenAI 兼容、Ollama），接口开放，社区可贡献更多。

OpenAI 兼容的服务（DeepSeek、Groq、Together 等）直接复用 `OpenAiApiAdapter`，只需换 baseUrl + apiKey，不算新 adapter。

---

## 分阶段实施

### Phase 1: 后端抽象 + Model Registry（v4.0-alpha）
**目标：** 不改变外部行为，内部重构

- [ ] 定义 `BackendAdapter` 接口 + `UnifiedChunk` 类型
- [ ] `model-registry.mjs` — 模型到 backend 的静态映射
  - `getBackendForModel(model) → backendId`
- [ ] `agent-router.mjs` — 路由决策引擎
  - `resolveBackend({ agent, model }) → backendId`
  - 实现决策顺序：agent override → model registry → default → fallback
- [ ] 将 Claude CLI 逻辑封装为 `ClaudeCliAdapter`
  - stdout → UnifiedChunk 转换
  - costType = "estimated"
- [ ] 抽取 `SessionManager`（从 server.mjs）
- [ ] 抽取 `StatsCollector`（per-agent, per-backend）
- [ ] Config v4 格式（带 version + validation）：

```json
{
  "version": "4.0",
  "backends": {
    "claude-cli": {
      "type": "claude-cli",
      "tier": "core",
      "enabled": true,
      "models": ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
      "maxConcurrent": 4,
      "timeout": { "firstByte": 120000, "overall": 300000 },
      "estimatedCostPerMTok": { "input": 3.0, "output": 15.0 }
    }
  },
  "agents": {
    "default": { "preferred": "claude-cli", "fallback": null }
  }
}
```

- [ ] 启动时 config validation
- [ ] `/ocp backends` 命令
- [ ] 所有现有测试通过，行为不变

**验收标准：** 现有用户升级后零感知变化

### Phase 2: OpenAI API 后端（v4.0-beta）
**目标：** 第二个 backend，验证 adapter 抽象

- [ ] `OpenAiApiAdapter`
  - SSE → UnifiedChunk
  - costType = "actual"
  - 支持任何 OpenAI 兼容端点（baseUrl + apiKey）
- [ ] Model registry 自动注册新 backend 的 models
- [ ] Agent routing 生效：

```json
{
  "agents": {
    "default": { "preferred": "claude-cli", "fallback": "openai" },
    "interpreter": { "preferred": "openai/gpt-4o-mini", "fallback": null }
  }
}
```

- [ ] Non-streaming fallback（`allowFallback = !hasStartedStreaming`）
- [ ] Stats 按 backend + agent 分组

**验收标准：** claude-cli 挂了 → default agent 自动 fallback 到 openai

### Phase 3: Ollama + Agent Routing 稳定化（v4.0-rc）
**目标：** 摆脱付费依赖，agent routing 跑稳

- [ ] `OllamaAdapter`
  - 自动发现模型
  - costType = "free"
- [ ] Agent routing 完整覆盖所有 agent：

```json
{
  "agents": {
    "main":        { "preferred": "claude-cli/opus", "fallback": "openai" },
    "tech_geek":   { "preferred": "claude-cli/sonnet", "fallback": "ollama/qwen3" },
    "interpreter": { "preferred": "ollama/qwen3", "fallback": null }
  }
}
```

- [ ] `/ocp routing` — 显示每个 agent 当前走哪个 backend
- [ ] 端到端测试：Claude CLI 下线 → agent 自动 fallback → 恢复后自动回切

**验收标准：** 三个 backend 同时运行，每个 agent 走不同路径，稳定无错

### Phase 4: Budget + Cost Control（v4.1）
**目标：** 核心差异化 — agent-aware 成本控制

**前置条件：** Phase 3 routing 稳定（先确定流量怎么走 → 再控制花多少钱）

**安全原则：** 没有显式配置 budget 的 agent → 行为等同于 v3（不限制、不降级、不告警）。Budget 是 opt-in，不是 opt-out。

- [ ] Per-agent 预算：

```json
{
  "agents": {
    "main": {
      "preferred": "claude-cli/opus",
      "fallback": "openai",
      "dailyBudget": { "limit": 3.00, "onExhausted": "downgrade" }
    }
  },
  "budget": {
    "global": { "daily": 10.00, "onExhausted": "warn" }
  }
}
```

- [ ] 超预算行为：downgrade | block | warn
- [ ] `/ocp cost` — per-agent 成本（标注 actual/estimated/free）
- [ ] Telegram 告警（预算 80%、backend 连续失败）

### Phase 5: Anthropic 官方 API（v4.2，等时机）
- [ ] `AnthropicApiAdapter`（官方 SDK）
- [ ] 迁移指南：一行配置切换
- [ ] costType = "actual"

---

## 文件结构（目标）

```
claude-proxy/
├── server.mjs              → HTTP 层（统一 chunk → SSE 输出）
├── model-registry.mjs      → 模型注册表（model → backend 映射）
├── agent-router.mjs        → Agent 路由引擎（策略层）
├── session-manager.mjs     → 会话管理
├── stats-collector.mjs     → 统计 + 成本追踪
├── config.mjs              → 配置加载 + 版本验证
├── unified-chunk.mjs       → UnifiedChunk 类型定义
├── backends/
│   ├── base.mjs            → BackendAdapter 接口
│   ├── claude-cli.mjs      → Claude CLI（core）
│   ├── openai-api.mjs      → OpenAI 兼容（core）
│   └── ollama.mjs          → Ollama 本地（core）
├── setup.mjs               → 安装向导
└── ocp-plugin/             → Gateway 命令插件
```

---

## 配置完整示例（目标状态）

```json
{
  "version": "4.0",
  "port": 3456,

  "backends": {
    "claude-cli": {
      "type": "claude-cli",
      "tier": "core",
      "enabled": true,
      "models": ["claude-sonnet-4-6", "claude-opus-4-6"],
      "maxConcurrent": 4,
      "timeout": { "firstByte": 120000, "overall": 300000 },
      "estimatedCostPerMTok": { "input": 3.0, "output": 15.0 }
    },
    "openai": {
      "type": "openai-api",
      "tier": "core",
      "enabled": true,
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "models": ["anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash"],
      "maxConcurrent": 10,
      "timeout": { "firstByte": 30000, "overall": 120000 }
    },
    "ollama": {
      "type": "ollama",
      "tier": "core",
      "enabled": true,
      "baseUrl": "http://localhost:11434",
      "models": "auto"
    }
  },

  "agents": {
    "default": {
      "preferred": "claude-cli",
      "fallback": "openai"
    },
    "main": {
      "preferred": "claude-cli/claude-opus-4-6",
      "fallback": "openai",
      "dailyBudget": { "limit": 3.00, "onExhausted": "downgrade" }
    },
    "tech_geek": {
      "preferred": "claude-cli/claude-sonnet-4-6",
      "fallback": "ollama/qwen3",
      "dailyBudget": { "limit": 2.00, "onExhausted": "fallback" }
    },
    "interpreter": {
      "preferred": "ollama/qwen3",
      "fallback": null
    }
  },

  "fallback": {
    "onlyBeforeFirstByte": true,
    "triggers": ["timeout", "rate-limit", "connection-error"],
    "maxRetries": 1
  },

  "budget": {
    "global": { "daily": 10.00, "onExhausted": "warn" },
    "alerts": { "threshold": 0.8, "channel": "telegram" }
  },

  "sessions": { "ttl": 3600000, "maxPromptChars": 150000 },
  "monitoring": { "retainHours": 72 }
}
```

---

## 风险与应对

| 风险 | 应对 |
|------|------|
| Claude CLI 被封 | 切换 backend，上层不变 |
| Anthropic 出订阅 API | 实现 anthropic-api adapter，成本控制层继续有价值 |
| LiteLLM 竞争 | 不竞争。OCP 做 agent-aware 成本控制，赛道不同 |
| 成本数据不准 | cost type 标记 actual/estimated/free |
| Streaming fallback 拼接 | Phase 3 只做 non-streaming fallback |
| 过度工程 | 只维护 3 个 core backend，phase 严格拆分 |

## 优先级

| Phase | 时间 | 内容 | 交付物 |
|-------|------|------|--------|
| 1 | 本周 | 重构：adapter 接口 + model registry + agent router | 行为不变，架构就位 |
| 2 | 1-2 周 | OpenAI backend | 两个 backend 跑通 |
| 3 | 2-3 周 | Ollama + Agent routing 稳定化 | 三 backend + per-agent 路由 |
| 4 | 按需 | Budget + Cost control | 成本可控 |
| 5 | 等时机 | Anthropic 官方 API | 逃生通道 |

## 成功标准

1. Claude CLI 被封的那天，改一行配置，所有 agent 继续运行
2. `/ocp cost` 每个 agent 花了多少（actual/estimated/free）
3. 翻译 agent 自动用 Ollama（$0），coding agent 用 Claude
4. 超预算自动降级，不需人工干预
5. 新 backend 只需实现 BackendAdapter 接口 + 一个文件

## 设计审核记录

| 轮次 | 审核方 | 关键结论 |
|------|--------|----------|
| 第一轮 | AI-A | 定位从 proxy 转向成本控制器；识别 5 个 P0 问题 |
| 第二轮 | Claude（本项目开发者） | 反驳：不能删 model routing（基础设施层）；backend 数量是运营决策不是架构约束；budget 拆到 Phase 4 |
| 第三轮 | AI-A | 校准：model registry 与 routing 物理拆开两个模块；agent identity 结构预留 inferred 扩展点；backend 加 tier 标记 |

## 一句话总结

**短期靠套利活（Claude CLI proxy），长期靠控制力活（Agent 成本控制器）。两条腿走路，CLI 死了上层不死。**
