#!/usr/bin/env node
/**
 * openclaw-claude-proxy v2.4.0 — OpenAI-compatible proxy for Claude CLI
 *
 * Translates OpenAI chat/completions requests into `claude -p` CLI calls,
 * letting you use your Claude Pro/Max subscription as an OpenClaw model provider.
 *
 * v2.4.0:
 *   - Per-model circuit breaker: consecutive timeouts temporarily mark a model as degraded
 *   - Adaptive first-byte timeout: scales by model tier + prompt size
 *   - Structured JSON logging for key events (easier to parse/alert on)
 *   - On-demand spawning (no pool), session management, full tool access
 *
 * Env vars:
 *   CLAUDE_PROXY_PORT        — listen port (default: 3456)
 *   CLAUDE_BIN               — path to claude binary (default: auto-detect)
 *   CLAUDE_TIMEOUT           — per-request timeout in ms (default: 120000)
 *   CLAUDE_FIRST_BYTE_TIMEOUT — base first-byte timeout in ms (default: 45000)
 *   CLAUDE_ALLOWED_TOOLS     — comma-separated tools to allow (default: expanded set)
 *   CLAUDE_SKIP_PERMISSIONS  — "true" to bypass all permission checks (default: false)
 *   CLAUDE_SYSTEM_PROMPT     — system prompt appended to all requests
 *   CLAUDE_MCP_CONFIG        — path to MCP server config JSON file
 *   CLAUDE_SESSION_TTL       — session TTL in ms (default: 3600000 = 1h)
 *   CLAUDE_MAX_CONCURRENT    — max concurrent claude processes (default: 5)
 *   CLAUDE_BREAKER_THRESHOLD — consecutive timeouts before circuit opens (default: 3)
 *   CLAUDE_BREAKER_COOLDOWN  — ms to wait before retrying after circuit opens (default: 60000)
 *   PROXY_API_KEY            — Bearer token for API auth (optional)
 */
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const _pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

// ── Resolve claude binary ───────────────────────────────────────────────
// Priority: CLAUDE_BIN env > well-known paths > which lookup
// Fail-fast if not found — never start with an unresolvable binary.
function resolveClaude() {
  if (process.env.CLAUDE_BIN) {
    try {
      accessSync(process.env.CLAUDE_BIN, constants.X_OK);
      return process.env.CLAUDE_BIN;
    } catch {
      console.error(`FATAL: CLAUDE_BIN="${process.env.CLAUDE_BIN}" is set but not executable.`);
      process.exit(1);
    }
  }

  const candidates = [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    join(process.env.HOME || "", ".local/bin/claude"),
  ];
  for (const p of candidates) {
    try { accessSync(p, constants.X_OK); console.warn(`[init] CLAUDE_BIN not set, resolved to ${p}`); return p; } catch {}
  }

  try {
    const resolved = execFileSync("which", ["claude"], { encoding: "utf8", timeout: 5000 }).trim();
    if (resolved) { console.warn(`[init] CLAUDE_BIN not set, resolved via which: ${resolved}`); return resolved; }
  } catch {}

  console.error(
    "FATAL: claude binary not found.\n" +
    "  Set CLAUDE_BIN=/path/to/claude or ensure claude is in PATH.\n" +
    "  Checked: " + candidates.join(", ")
  );
  process.exit(1);
}

// ── Configuration ───────────────────────────────────────────────────────
const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || "3456", 10);
const CLAUDE = resolveClaude();
const TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || "120000", 10);
const BASE_FIRST_BYTE_TIMEOUT = parseInt(process.env.CLAUDE_FIRST_BYTE_TIMEOUT || "45000", 10);
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
const SKIP_PERMISSIONS = process.env.CLAUDE_SKIP_PERMISSIONS === "true";
const ALLOWED_TOOLS = (process.env.CLAUDE_ALLOWED_TOOLS ||
  "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Agent"
).split(",").map(s => s.trim()).filter(Boolean);
const SYSTEM_PROMPT = process.env.CLAUDE_SYSTEM_PROMPT || "";
const MCP_CONFIG = process.env.CLAUDE_MCP_CONFIG || "";
const SESSION_TTL = parseInt(process.env.CLAUDE_SESSION_TTL || "3600000", 10);
const MAX_CONCURRENT = parseInt(process.env.CLAUDE_MAX_CONCURRENT || "5", 10);
const BREAKER_THRESHOLD = parseInt(process.env.CLAUDE_BREAKER_THRESHOLD || "3", 10);
const BREAKER_COOLDOWN = parseInt(process.env.CLAUDE_BREAKER_COOLDOWN || "60000", 10);

const VERSION = _pkg.version;
const START_TIME = Date.now();

// ── Structured logging helper ───────────────────────────────────────────
function logEvent(level, event, data = {}) {
  const entry = { ts: new Date().toISOString(), level, event, ...data };
  if (level === "error" || level === "warn") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// ── Per-model circuit breaker ───────────────────────────────────────────
// Tracks consecutive timeouts per model. When threshold is reached, the
// model is marked "open" (degraded) for BREAKER_COOLDOWN ms. During that
// window, requests for this model fail fast with a clear error instead of
// waiting for yet another timeout that would block the gateway.
const breakers = new Map(); // cliModel → { failures, state, openedAt }

function getBreakerState(cliModel) {
  if (!breakers.has(cliModel)) {
    breakers.set(cliModel, { failures: 0, state: "closed", openedAt: 0 });
  }
  const b = breakers.get(cliModel);

  // Auto-recover: if cooldown has elapsed, transition to half-open
  if (b.state === "open" && Date.now() - b.openedAt >= BREAKER_COOLDOWN) {
    b.state = "half-open";
    logEvent("info", "breaker_half_open", { model: cliModel, cooldownMs: BREAKER_COOLDOWN });
  }
  return b;
}

function breakerRecordSuccess(cliModel) {
  const b = getBreakerState(cliModel);
  if (b.failures > 0 || b.state !== "closed") {
    logEvent("info", "breaker_reset", { model: cliModel, previousFailures: b.failures, previousState: b.state });
  }
  b.failures = 0;
  b.state = "closed";
  b.openedAt = 0;
}

function breakerRecordTimeout(cliModel) {
  const b = getBreakerState(cliModel);
  b.failures++;
  logEvent("warn", "breaker_failure", { model: cliModel, consecutiveFailures: b.failures, threshold: BREAKER_THRESHOLD });

  if (b.failures >= BREAKER_THRESHOLD && b.state !== "open") {
    b.state = "open";
    b.openedAt = Date.now();
    logEvent("error", "breaker_open", { model: cliModel, failures: b.failures, cooldownMs: BREAKER_COOLDOWN });
  }
}

// ── Model mapping ───────────────────────────────────────────────────────
// Maps request model IDs and aliases to canonical claude CLI model IDs.
const MODEL_MAP = {
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  "claude-opus-4": "claude-opus-4-6",
  "claude-haiku-4": "claude-haiku-4-5-20251001",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "opus": "claude-opus-4-6",
  "sonnet": "claude-sonnet-4-6",
  "haiku": "claude-haiku-4-5-20251001",
};

const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
];

// ── Session management ──────────────────────────────────────────────────
// Maps conversation IDs (from caller) to Claude CLI session UUIDs.
// Enables --resume for multi-turn conversations, reducing token waste.
const sessions = new Map(); // conversationId → { uuid, messageCount, lastUsed, model }

const sessionCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL) {
      sessions.delete(id);
      console.log(`[session] expired ${id.slice(0, 12)}... (idle ${Math.round((now - s.lastUsed) / 60000)}m)`);
    }
  }
}, 60000);

// ── Active child process tracking ────────────────────────────────────────
const activeProcesses = new Set();

// ── Stats & diagnostics ─────────────────────────────────────────────────
const stats = {
  totalRequests: 0,
  activeRequests: 0,
  errors: 0,
  timeouts: 0,
  sessionHits: 0,
  sessionMisses: 0,
  oneOffRequests: 0,
};
const recentErrors = []; // last 20 errors

function trackError(msg) {
  stats.errors++;
  recentErrors.push({ time: new Date().toISOString(), message: String(msg).slice(0, 200) });
  if (recentErrors.length > 20) recentErrors.shift();
}

// ── Auth health check ───────────────────────────────────────────────────
let authStatus = { ok: null, lastCheck: 0, message: "" };

async function checkAuth() {
  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    execFileSync(CLAUDE, ["auth", "status"], { encoding: "utf8", timeout: 10000, env });
    authStatus = { ok: true, lastCheck: Date.now(), message: "authenticated" };
  } catch (e) {
    const msg = (e.stderr || e.message || "").slice(0, 200);
    authStatus = { ok: false, lastCheck: Date.now(), message: msg };
    console.error(`[auth] check failed: ${msg}`);
  }
}

// Check auth on start and every 10 minutes
checkAuth();
const authCheckInterval = setInterval(checkAuth, 600000);

// ── Build CLI arguments ─────────────────────────────────────────────────
function buildCliArgs(cliModel, sessionInfo) {
  const args = ["-p", "--model", cliModel, "--output-format", "text"];

  // Session handling
  if (sessionInfo?.resume) {
    args.push("--resume", sessionInfo.uuid);
  } else if (sessionInfo?.uuid) {
    args.push("--session-id", sessionInfo.uuid);
  } else {
    args.push("--no-session-persistence");
  }

  // Permissions
  if (SKIP_PERMISSIONS) {
    args.push("--dangerously-skip-permissions");
  } else if (ALLOWED_TOOLS.length > 0) {
    args.push("--allowedTools", ...ALLOWED_TOOLS);
  }

  // System prompt
  if (SYSTEM_PROMPT) {
    args.push("--append-system-prompt", SYSTEM_PROMPT);
  }

  // MCP config
  if (MCP_CONFIG) {
    args.push("--mcp-config", MCP_CONFIG);
  }

  return args;
}

// ── Format messages to prompt text ──────────────────────────────────────
function messagesToPrompt(messages) {
  return messages.map((m) => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (m.role === "system") return `[System] ${text}`;
    if (m.role === "assistant") return `[Assistant] ${text}`;
    return text;
  }).join("\n\n");
}

// Model tier multipliers for first-byte timeout.
// Opus is much slower to produce first token, especially with large contexts.
const MODEL_TIMEOUT_TIERS = {
  "opus": { base: 60000, perPromptChar: 0.00015 },    // 60s base + ~15s per 100k chars
  "sonnet": { base: 45000, perPromptChar: 0.00008 },  // 45s base + ~8s per 100k chars
  "haiku": { base: 30000, perPromptChar: 0.00005 },   // 30s base + ~5s per 100k chars
};

function getModelTier(cliModel) {
  if (cliModel.includes("opus")) return "opus";
  if (cliModel.includes("haiku")) return "haiku";
  return "sonnet";
}

function computeFirstByteTimeout(cliModel, promptLength) {
  const tier = MODEL_TIMEOUT_TIERS[getModelTier(cliModel)];
  const timeout = tier.base + Math.floor(promptLength * tier.perPromptChar);
  return Math.min(timeout, Math.max(TIMEOUT - 5000, 10000));
}

// ── Spawn claude CLI (shared setup) ─────────────────────────────────────
// Resolves session logic, builds CLI args, spawns the process, and sets up
// timeouts. Returns context object or throws synchronously.
function spawnClaudeProcess(model, messages, conversationId) {
  if (stats.activeRequests >= MAX_CONCURRENT) {
    throw new Error(`concurrency limit reached (${stats.activeRequests}/${MAX_CONCURRENT})`);
  }

  const cliModel = MODEL_MAP[model] || model;

  // Circuit breaker check: fail fast if model is in open state
  const breaker = getBreakerState(cliModel);
  if (breaker.state === "open") {
    const remainingMs = BREAKER_COOLDOWN - (Date.now() - breaker.openedAt);
    logEvent("warn", "breaker_rejected", { model: cliModel, remainingCooldownMs: remainingMs });
    throw new Error(`circuit breaker open for ${cliModel}: ${breaker.failures} consecutive timeouts, retry in ${Math.ceil(remainingMs / 1000)}s`);
  }

  stats.activeRequests++;
  stats.totalRequests++;

  let sessionInfo = null;
  let prompt;

  // ── Session logic ──
  if (conversationId && sessions.has(conversationId)) {
    const session = sessions.get(conversationId);
    session.lastUsed = Date.now();
    sessionInfo = { uuid: session.uuid, resume: true };
    stats.sessionHits++;

    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    prompt = lastUserMsg
      ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg.content))
      : "";
    session.messageCount = messages.length;

    console.log(`[session] resume conv=${conversationId.slice(0, 12)}... uuid=${session.uuid.slice(0, 8)}... msgs=${messages.length} prompt_chars=${prompt.length}`);

  } else if (conversationId) {
    const uuid = randomUUID();
    sessions.set(conversationId, { uuid, messageCount: messages.length, lastUsed: Date.now(), model: cliModel });
    sessionInfo = { uuid, resume: false };
    stats.sessionMisses++;
    prompt = messagesToPrompt(messages);

    console.log(`[session] new conv=${conversationId.slice(0, 12)}... uuid=${uuid.slice(0, 8)}... msgs=${messages.length}`);

  } else {
    stats.oneOffRequests++;
    prompt = messagesToPrompt(messages);
  }

  const cliArgs = buildCliArgs(cliModel, sessionInfo);

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const proc = spawn(CLAUDE, cliArgs, { env, stdio: ["pipe", "pipe", "pipe"] });
  activeProcesses.add(proc);

  const t0 = Date.now();
  const firstByteTimeoutMs = computeFirstByteTimeout(cliModel, prompt.length);
  let gotFirstByte = false;
  let cleaned = false;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(overallTimer);
    clearTimeout(firstByteTimer);
    stats.activeRequests--;
  }

  function handleSessionFailure() {
    if (sessionInfo?.resume && conversationId) {
      console.warn(`[session] resume failed for ${conversationId.slice(0, 12)}..., removing stale session`);
      sessions.delete(conversationId);
    }
  }

  function markFirstByte() {
    if (!gotFirstByte) {
      gotFirstByte = true;
      clearTimeout(firstByteTimer);
      console.log(`[claude] first-byte model=${cliModel} elapsed=${Date.now() - t0}ms`);
    }
  }

  // Write prompt to stdin immediately
  proc.stdin.write(prompt);
  proc.stdin.end();

  logEvent("info", "claude_spawned", { model: cliModel, promptChars: prompt.length, firstByteTimeout: firstByteTimeoutMs, tier: getModelTier(cliModel), session: conversationId ? conversationId.slice(0, 12) + "..." : "none" });

  // First-byte timeout
  const firstByteTimer = setTimeout(() => {
    if (!gotFirstByte && !cleaned) {
      stats.timeouts++;
      breakerRecordTimeout(cliModel);
      logEvent("error", "first_byte_timeout", { model: cliModel, timeoutMs: firstByteTimeoutMs, promptChars: prompt.length });
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
    }
  }, firstByteTimeoutMs);

  // Overall request timeout
  const overallTimer = setTimeout(() => {
    if (!cleaned) {
      stats.timeouts++;
      breakerRecordTimeout(cliModel);
      logEvent("error", "request_timeout", { model: cliModel, timeoutMs: TIMEOUT });
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
    }
  }, TIMEOUT);

  return { proc, cliModel, conversationId, t0, cleanup, handleSessionFailure, markFirstByte };
}

// ── Call claude CLI (non-streaming) ─────────────────────────────────────
// On-demand spawning: each request spawns a fresh `claude -p` process.
// No pool = no crash loops, no stale workers, no degraded states.
// Stdin is written immediately so there's no 3s stdin timeout issue.
function callClaude(model, messages, conversationId) {
  return new Promise((resolve, reject) => {
    let ctx;
    try {
      ctx = spawnClaudeProcess(model, messages, conversationId);
    } catch (err) {
      return reject(err);
    }

    const { proc, cliModel, conversationId: convId, t0, cleanup, handleSessionFailure, markFirstByte } = ctx;
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      markFirstByte();
      stdout += d;
    });
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code, signal) => {
      activeProcesses.delete(proc);
      const elapsed = Date.now() - t0;
      cleanup();
      if (code !== 0) {
        logEvent("error", "claude_exit", { model: cliModel, code, signal: signal || "none", elapsed, stderr: stderr.slice(0, 300) });
        trackError(stderr.slice(0, 300) || stdout.slice(0, 300) || `claude exit ${code}`);
        handleSessionFailure();
        reject(new Error(stderr.slice(0, 300) || stdout.slice(0, 300) || `claude exit ${code}`));
      } else {
        breakerRecordSuccess(cliModel);
        logEvent("info", "claude_ok", { model: cliModel, chars: stdout.length, elapsed, session: convId ? convId.slice(0, 12) + "..." : "none" });
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => {
      console.error(`[claude] spawn error: ${err.message}`);
      cleanup();
      trackError(err.message);
      handleSessionFailure();
      reject(err);
    });
  });
}

// ── Call claude CLI (real streaming) ─────────────────────────────────────
// Pipes stdout from the claude process directly to SSE chunks as they arrive.
// Each data chunk becomes a proper SSE event with delta content in real time.
function callClaudeStreaming(model, messages, conversationId, res) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let ctx;
  try {
    ctx = spawnClaudeProcess(model, messages, conversationId);
  } catch (err) {
    return jsonResponse(res, 500, { error: { message: err.message, type: "proxy_error" } });
  }

  const { proc, cliModel, conversationId: convId, t0, cleanup, handleSessionFailure, markFirstByte } = ctx;
  let stderr = "";
  let headersSent = false;
  let totalChars = 0;

  function ensureHeaders() {
    if (headersSent || res.writableEnded || res.destroyed) return false;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    // Send initial role chunk
    sendSSE(res, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    return true;
  }

  proc.stdout.on("data", (d) => {
    markFirstByte();
    const text = d.toString();
    totalChars += text.length;

    if (!ensureHeaders()) return;

    // Stream each chunk as it arrives from the CLI process
    sendSSE(res, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    });
  });

  proc.stderr.on("data", (d) => (stderr += d));

  proc.on("close", (code, signal) => {
    activeProcesses.delete(proc);
    cleanup();
    const elapsed = Date.now() - t0;

    if (code !== 0) {
      logEvent("error", "claude_exit", { model: cliModel, code, signal: signal || "none", elapsed, stderr: stderr.slice(0, 300) });
      trackError(stderr.slice(0, 300) || `claude exit ${code}`);
      handleSessionFailure();

      if (!headersSent && !res.writableEnded && !res.destroyed) {
        // No output was sent yet — return a JSON error
        jsonResponse(res, 500, { error: { message: stderr.slice(0, 300) || `claude exit ${code}`, type: "proxy_error" } });
      } else if (!res.writableEnded && !res.destroyed) {
        // Already streaming — close the stream gracefully
        sendSSE(res, {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } else {
      breakerRecordSuccess(cliModel);
      logEvent("info", "claude_ok", { model: cliModel, chars: totalChars, elapsed, session: convId ? convId.slice(0, 12) + "..." : "none" });

      if (!headersSent) ensureHeaders();
      if (!res.writableEnded && !res.destroyed) {
        sendSSE(res, {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  });

  proc.on("error", (err) => {
    console.error(`[claude] spawn error: ${err.message}`);
    cleanup();
    trackError(err.message);
    handleSessionFailure();
    if (!headersSent && !res.writableEnded && !res.destroyed) {
      jsonResponse(res, 500, { error: { message: err.message, type: "proxy_error" } });
    } else if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  });

  // If client disconnects, kill the process to free resources
  res.on("close", () => {
    if (!proc.killed) {
      try { proc.kill("SIGTERM"); } catch {}
    }
  });
}

// ── Response helpers ────────────────────────────────────────────────────
function jsonResponse(res, status, data) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function completionResponse(res, id, model, content) {
  jsonResponse(res, 200, {
    id, object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

// ── Handle chat completions ─────────────────────────────────────────────
const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB

// Set of all valid model identifiers (canonical IDs + aliases)
const VALID_MODELS = new Set(Object.keys(MODEL_MAP));

async function handleChatCompletions(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_SIZE) {
      return jsonResponse(res, 413, { error: { message: "Request body too large (max 5MB)", type: "invalid_request_error" } });
    }
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }

  const messages = parsed.messages || parsed.input || [{ role: "user", content: parsed.prompt || "" }];
  const model = parsed.model || "claude-sonnet-4-6";
  const stream = parsed.stream;

  // Validate model against known models
  if (!VALID_MODELS.has(model)) {
    return jsonResponse(res, 400, { error: { message: `Unknown model: ${model}. Valid models: ${[...VALID_MODELS].join(", ")}`, type: "invalid_request_error" } });
  }

  // Session ID: from request body, header, or null (one-off)
  const conversationId = parsed.session_id || parsed.conversation_id || req.headers["x-session-id"] || req.headers["x-conversation-id"] || null;

  if (!messages?.length) return jsonResponse(res, 400, { error: "messages required" });

  if (stream) {
    // Real streaming: pipe stdout from claude process directly as SSE chunks
    return callClaudeStreaming(model, messages, conversationId, res);
  }

  try {
    const content = await callClaude(model, messages, conversationId);
    const id = `chatcmpl-${randomUUID()}`;
    completionResponse(res, id, model, content);
  } catch (err) {
    console.error(`[proxy] error: ${err.message}`);
    if (res.headersSent || res.writableEnded || res.destroyed) {
      try { res.end(); } catch {}
      return;
    }
    // Sanitize error: strip internal file paths before sending to client
    const safeMessage = (err.message || "Internal error").replace(/\/[\w/.\-]+/g, "[path]");
    jsonResponse(res, 500, { error: { message: safeMessage, type: "proxy_error" } });
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // Dynamic CORS: only allow localhost origins
  const origin = req.headers["origin"] || "";
  const isLocalhost = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  res.setHeader("Access-Control-Allow-Origin", isLocalhost ? origin : `http://127.0.0.1:${PORT}`);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id, X-Conversation-Id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Bearer token auth (skip for /health and when PROXY_API_KEY is not set)
  if (PROXY_API_KEY && req.url !== "/health") {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const tokenBuf = Buffer.from(token);
    const keyBuf = Buffer.from(PROXY_API_KEY);
    if (tokenBuf.length !== keyBuf.length || !timingSafeEqual(tokenBuf, keyBuf)) {
      return jsonResponse(res, 401, { error: { message: "Unauthorized: invalid or missing Bearer token", type: "auth_error" } });
    }
  }

  // GET /v1/models
  if (req.url === "/v1/models" && req.method === "GET") {
    return jsonResponse(res, 200, {
      object: "list",
      data: MODELS.map((m) => ({
        id: m.id, object: "model", owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      })),
    });
  }

  // POST /v1/chat/completions
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletions(req, res);
  }

  // GET /health — comprehensive diagnostics
  if (req.url === "/health") {
    let binaryOk = false;
    try { accessSync(CLAUDE, constants.X_OK); binaryOk = true; } catch {}

    const uptimeMs = Date.now() - START_TIME;
    const sessionList = [];
    for (const [id, s] of sessions) {
      sessionList.push({
        id: id.slice(0, 12) + "...",
        model: s.model,
        messages: s.messageCount,
        idleMs: Date.now() - s.lastUsed,
      });
    }

    return jsonResponse(res, 200, {
      status: binaryOk && authStatus.ok !== false ? "ok" : "degraded",
      version: VERSION,
      architecture: "on-demand (v2)",
      uptime: uptimeMs,
      uptimeHuman: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
      claudeBinary: CLAUDE,
      claudeBinaryOk: binaryOk,
      auth: authStatus,
      config: {
        timeout: TIMEOUT,
        firstByteTimeout: BASE_FIRST_BYTE_TIMEOUT,
        maxConcurrent: MAX_CONCURRENT,
        sessionTTL: SESSION_TTL,
        allowedTools: SKIP_PERMISSIONS ? "all (skip-permissions)" : ALLOWED_TOOLS,
        systemPrompt: SYSTEM_PROMPT ? `${SYSTEM_PROMPT.slice(0, 50)}...` : "(none)",
        mcpConfig: MCP_CONFIG || "(none)",
      },
      stats,
      sessions: sessionList,
      recentErrors: recentErrors.slice(-5),
    });
  }

  // DELETE /sessions — clear all sessions
  if (req.url === "/sessions" && req.method === "DELETE") {
    const count = sessions.size;
    sessions.clear();
    return jsonResponse(res, 200, { cleared: count });
  }

  // GET /sessions — list active sessions
  if (req.url === "/sessions" && req.method === "GET") {
    const list = [];
    for (const [id, s] of sessions) {
      list.push({ id, uuid: s.uuid, model: s.model, messages: s.messageCount, lastUsed: new Date(s.lastUsed).toISOString() });
    }
    return jsonResponse(res, 200, { sessions: list });
  }

  jsonResponse(res, 404, { error: "Not found. Endpoints: GET /v1/models, POST /v1/chat/completions, GET /health, GET|DELETE /sessions" });
});


// ── Graceful shutdown ────────────────────────────────────────────────────
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent("info", "shutdown_start", { signal });

  // 1. Stop accepting new connections
  server.close(() => {
    logEvent("info", "shutdown_server_closed", {});
  });

  // 2. Clear intervals/timers
  clearInterval(sessionCleanupInterval);
  clearInterval(authCheckInterval);

  // 3. Kill all active child processes
  for (const proc of activeProcesses) {
    try { proc.kill("SIGTERM"); } catch {}
  }

  // Force-kill any remaining processes after 5s, then exit
  const forceExitTimer = setTimeout(() => {
    for (const proc of activeProcesses) {
      try { proc.kill("SIGKILL"); } catch {}
    }
    logEvent("warn", "shutdown_forced", { remainingProcesses: activeProcesses.size });
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();

  // If no active processes, exit immediately
  if (activeProcesses.size === 0) {
    logEvent("info", "shutdown_complete", {});
    process.exit(0);
  }

  // Wait for active processes to finish
  const checkDone = setInterval(() => {
    if (activeProcesses.size === 0) {
      clearInterval(checkDone);
      logEvent("info", "shutdown_complete", {});
      process.exit(0);
    }
  }, 200);
  checkDone.unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ── Start ───────────────────────────────────────────────────────────────
server.listen(PORT, "127.0.0.1", () => {
  console.log(`openclaw-claude-proxy v${VERSION} listening on http://127.0.0.1:${PORT}`);
  console.log(`Architecture: on-demand spawning (no pool)`);
  console.log(`Models: ${MODELS.map((m) => m.id).join(", ")}`);
  console.log(`Claude binary: ${CLAUDE}`);
  console.log(`Timeout: ${TIMEOUT}ms (base first-byte: ${BASE_FIRST_BYTE_TIMEOUT}ms, adaptive by model/prompt) | Max concurrent: ${MAX_CONCURRENT}`);
  console.log(`Tools: ${SKIP_PERMISSIONS ? "all (skip-permissions)" : ALLOWED_TOOLS.join(", ")}`);
  console.log(`Sessions: TTL=${SESSION_TTL / 1000}s`);
  if (SYSTEM_PROMPT) console.log(`System prompt: "${SYSTEM_PROMPT.slice(0, 80)}..."`);
  if (MCP_CONFIG) console.log(`MCP config: ${MCP_CONFIG}`);
  console.log(`Auth: ${PROXY_API_KEY ? "enabled (PROXY_API_KEY set)" : "disabled (no PROXY_API_KEY)"}`);
  console.log(`---`);
  console.log(`Coexistence: This proxy does NOT conflict with Claude Code interactive mode.`);
  console.log(`  OCP uses: localhost:${PORT} (HTTP) → claude -p (per-request process)`);
  console.log(`  CC uses:  MCP protocol (in-process) → persistent session`);
  console.log(`  Both can run simultaneously on the same machine.`);
});
