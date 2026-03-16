#!/usr/bin/env node
/**
 * openclaw-claude-proxy — OpenAI-compatible proxy for Claude CLI
 *
 * Translates OpenAI chat/completions requests into `claude -p` CLI calls,
 * letting you use your Claude Pro/Max subscription as an OpenClaw model provider.
 *
 * Supports both streaming (SSE) and non-streaming responses.
 *
 * Env vars:
 *   CLAUDE_PROXY_PORT  — listen port (default: 3456)
 *   CLAUDE_BIN         — path to claude binary (default: "claude")
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || "3456", 10);
const CLAUDE = process.env.CLAUDE_BIN || "claude";
const TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || "120000", 10);

// Model alias mapping: request model → claude CLI --model arg
const MODEL_MAP = {
  "claude-opus-4-6": "opus",
  "claude-opus-4": "opus",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-4": "sonnet",
  "claude-haiku-4": "haiku",
};

const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4", name: "Claude Haiku 4" },
];

// ── Call claude CLI ─────────────────────────────────────────────────────
function callClaude(model, messages) {
  return new Promise((resolve, reject) => {
    const prompt = messages
      .map((m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        if (m.role === "system") return `[System] ${text}`;
        if (m.role === "assistant") return `[Assistant] ${text}`;
        return text;
      })
      .join("\n\n");

    const cliModel = MODEL_MAP[model] || model;
    const args = ["-p", "--model", cliModel, "--output-format", "text", "--no-session-persistence", "--", prompt];
    const env = { ...process.env };
    delete env.CLAUDECODE;

    let stdout = "";
    let stderr = "";
    const proc = spawn(CLAUDE, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[claude] exit=${code} model=${cliModel} stderr=${stderr.slice(0, 300)}`);
        reject(new Error(stderr || stdout || `exit ${code}`));
      } else {
        console.log(`[claude] ok model=${cliModel} chars=${stdout.length}`);
        resolve(stdout.trim());
      }
    });
    proc.on("error", reject);
    const timer = setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, TIMEOUT);
    proc.on("close", () => clearTimeout(timer));
  });
}

// ── Response helpers ────────────────────────────────────────────────────
function jsonResponse(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamResponse(res, id, model, content) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const created = Math.floor(Date.now() / 1000);
  // Role chunk
  sendSSE(res, {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  // Content chunks (~500 chars each)
  for (let i = 0; i < content.length; i += 500) {
    sendSSE(res, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: content.slice(i, i + 500) }, finish_reason: null }],
    });
  }
  // Finish
  sendSSE(res, {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
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
async function handleChatCompletions(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;

  let parsed;
  try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }

  const messages = parsed.messages || parsed.input || [{ role: "user", content: parsed.prompt || "" }];
  const model = parsed.model || "claude-sonnet-4-6";
  const stream = parsed.stream;

  if (!messages?.length) return jsonResponse(res, 400, { error: "messages required" });

  try {
    const content = await callClaude(model, messages);
    const id = `chatcmpl-${randomUUID()}`;

    if (stream) {
      streamResponse(res, id, model, content);
    } else {
      completionResponse(res, id, model, content);
    }
  } catch (err) {
    console.error(`[proxy] error: ${err.message}`);
    jsonResponse(res, 500, { error: { message: err.message, type: "proxy_error" } });
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

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

  // Health check
  if (req.url === "/health") return jsonResponse(res, 200, { status: "ok" });

  // Catch-all: try to handle any POST with messages
  if (req.method === "POST") {
    return handleChatCompletions(req, res);
  }

  jsonResponse(res, 404, { error: "Not found. Endpoints: GET /v1/models, POST /v1/chat/completions, GET /health" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`openclaw-claude-proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`Models: ${MODELS.map((m) => m.id).join(", ")}`);
  console.log(`Claude binary: ${CLAUDE}`);
  console.log(`Timeout: ${TIMEOUT}ms`);
});
