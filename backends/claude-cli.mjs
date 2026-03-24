/**
 * ClaudeCliAdapter — OCP backend for Claude via local CLI binary.
 *
 * Spawns `claude -p` processes for each request. Converts CLI stdout
 * into UnifiedChunk streaming protocol.
 *
 * costType: "estimated" (no actual cost data from CLI)
 */

import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { BackendAdapter } from "./base.mjs";
import { delta, done, error } from "../unified-chunk.mjs";

// Default models exposed by this backend
const DEFAULT_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

// Alias → canonical model mapping
const MODEL_ALIASES = {
  "claude-opus-4": "claude-opus-4-6",
  "claude-haiku-4": "claude-haiku-4-5-20251001",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "opus": "claude-opus-4-6",
  "sonnet": "claude-sonnet-4-6",
  "haiku": "claude-haiku-4-5-20251001",
};

export class ClaudeCliAdapter extends BackendAdapter {
  constructor(config = {}) {
    super(config);
    this._claudeBin = null;
    this._activeProcesses = new Set();
    this._maxConcurrent = config.maxConcurrent || 8;
    this._timeout = config.timeout?.overall || 300000;
    this._skipPermissions = config.skipPermissions || false;
    this._allowedTools = config.allowedTools || [
      "Bash", "Read", "Write", "Edit", "Glob", "Grep",
      "WebSearch", "WebFetch", "Agent",
    ];
    this._systemPrompt = config.systemPrompt || "";
    this._mcpConfig = config.mcpConfig || "";
    this._modelList = config.models || DEFAULT_MODELS;

    // Timeout tiers: per-model base + per-prompt-char scaling
    this._timeoutTiers = config.timeoutTiers || {
      opus: { base: 150000, perPromptChar: 0.00050 },
      sonnet: { base: 120000, perPromptChar: 0.00050 },
      haiku: { base: 45000, perPromptChar: 0.00010 },
    };

    // Estimated cost per MTok (for cost tracking)
    this._estimatedCost = config.estimatedCostPerMTok || {
      input: 3.0,
      output: 15.0,
    };
  }

  get id() { return "claude-cli"; }
  get displayName() { return "Claude CLI"; }
  get models() { return this._modelList; }
  get costType() { return "estimated"; }
  get tier() { return "core"; }
  get activeProcessCount() { return this._activeProcesses.size; }

  /**
   * Resolve a model ID, handling aliases.
   * Returns canonical CLI model ID or the input if no alias found.
   */
  resolveModel(model) {
    return MODEL_ALIASES[model] || model;
  }

  supportsModel(model) {
    const canonical = this.resolveModel(model);
    return this._modelList.includes(canonical) || model in MODEL_ALIASES;
  }

  async initialize() {
    this._claudeBin = this._resolveBinary();
  }

  async shutdown() {
    for (const proc of this._activeProcesses) {
      try { proc.kill("SIGTERM"); } catch {}
    }
    // Force kill after 5s
    if (this._activeProcesses.size > 0) {
      await new Promise(r => setTimeout(r, 5000));
      for (const proc of this._activeProcesses) {
        try { proc.kill("SIGKILL"); } catch {}
      }
    }
  }

  async healthCheck() {
    const t0 = Date.now();
    try {
      const env = this._cleanEnv();
      execFileSync(this._claudeBin, ["auth", "status"], {
        encoding: "utf8", timeout: 10000, env,
      });
      return { ok: true, message: "authenticated", latencyMs: Date.now() - t0 };
    } catch (e) {
      return {
        ok: false,
        message: (e.stderr || e.message || "").slice(0, 200),
        latencyMs: Date.now() - t0,
      };
    }
  }

  /**
   * Execute a chat completion via Claude CLI.
   * Yields UnifiedChunks as stdout data arrives.
   */
  async *chatCompletion(request) {
    const { model, messages, session, promptText } = request;
    const cliModel = this.resolveModel(model);

    if (this._activeProcesses.size >= this._maxConcurrent) {
      yield error(
        `concurrency limit reached (${this._activeProcesses.size}/${this._maxConcurrent})`,
        cliModel, this.id,
      );
      return;
    }

    const prompt = promptText || this._messagesToPrompt(messages);
    const cliArgs = this._buildCliArgs(cliModel, session);
    const env = this._cleanEnv();

    const proc = spawn(this._claudeBin, cliArgs, {
      env, stdio: ["pipe", "pipe", "pipe"],
    });
    this._activeProcesses.add(proc);

    const t0 = Date.now();
    const firstByteTimeoutMs = this._computeFirstByteTimeout(cliModel, prompt.length);
    let gotFirstByte = false;
    let totalChars = 0;
    let stderr = "";
    let finished = false;

    // Create a promise-based wrapper for the process
    try {
      yield* await new Promise((resolve, reject) => {
        const chunks = [];
        let streamResolve = null;
        let streamDone = false;

        // We can't directly yield from inside callbacks, so we collect
        // and use a different approach — return an async iterable.
        // Actually, let's use a simpler pattern with a queue.
        reject(new Error("USE_QUEUE_PATTERN"));
      });
    } catch {
      // Fall through to queue-based pattern below
    }

    // Queue-based async generator pattern
    const queue = [];
    let queueResolve = null;
    let queueDone = false;

    function enqueue(chunk) {
      if (queueDone) return;
      if (queueResolve) {
        const r = queueResolve;
        queueResolve = null;
        r(chunk);
      } else {
        queue.push(chunk);
      }
    }

    function waitForChunk() {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      if (queueDone) return Promise.resolve(null);
      return new Promise(r => { queueResolve = r; });
    }

    // Write prompt to stdin
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on("data", (d) => {
      if (!gotFirstByte) {
        gotFirstByte = true;
        clearTimeout(firstByteTimer);
      }
      const text = d.toString();
      totalChars += text.length;
      enqueue(delta(text, cliModel, this.id));
    });

    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("close", (code, signal) => {
      this._activeProcesses.delete(proc);
      clearTimeout(firstByteTimer);
      clearTimeout(overallTimer);
      const elapsed = Date.now() - t0;

      if (code !== 0) {
        const msg = stderr.slice(0, 300) || `claude exit ${code}`;
        enqueue(error(msg, cliModel, this.id));
      } else {
        // Estimate cost based on prompt + completion chars
        const estimatedInputTokens = Math.ceil(prompt.length / 4);
        const estimatedOutputTokens = Math.ceil(totalChars / 4);
        enqueue(done(cliModel, this.id, {
          promptTokens: estimatedInputTokens,
          completionTokens: estimatedOutputTokens,
        }, {
          value: (estimatedInputTokens * this._estimatedCost.input +
                  estimatedOutputTokens * this._estimatedCost.output) / 1000000,
          type: "estimated",
        }));
      }
      queueDone = true;
      if (queueResolve) {
        const r = queueResolve;
        queueResolve = null;
        r(null);
      }
    });

    proc.on("error", (err) => {
      this._activeProcesses.delete(proc);
      clearTimeout(firstByteTimer);
      clearTimeout(overallTimer);
      enqueue(error(err.message, cliModel, this.id));
      queueDone = true;
      if (queueResolve) {
        const r = queueResolve;
        queueResolve = null;
        r(null);
      }
    });

    // First-byte timeout
    const firstByteTimer = setTimeout(() => {
      if (!gotFirstByte) {
        try { proc.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
        enqueue(error(`first-byte timeout after ${firstByteTimeoutMs}ms`, cliModel, this.id));
        queueDone = true;
      }
    }, firstByteTimeoutMs);

    // Overall timeout
    const overallTimer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
      enqueue(error(`request timeout after ${this._timeout}ms`, cliModel, this.id));
      queueDone = true;
    }, this._timeout);

    // Yield chunks as they arrive
    while (true) {
      const chunk = await waitForChunk();
      if (chunk === null) break;
      yield chunk;
      if (chunk.type === "done" || chunk.type === "error") break;
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  _resolveBinary() {
    if (process.env.CLAUDE_BIN) {
      try {
        accessSync(process.env.CLAUDE_BIN, constants.X_OK);
        return process.env.CLAUDE_BIN;
      } catch {
        throw new Error(`CLAUDE_BIN="${process.env.CLAUDE_BIN}" is set but not executable.`);
      }
    }

    const candidates = [
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      "/usr/bin/claude",
      join(process.env.HOME || "", ".local/bin/claude"),
    ];
    for (const p of candidates) {
      try { accessSync(p, constants.X_OK); return p; } catch {}
    }

    try {
      const resolved = execFileSync("which", ["claude"], {
        encoding: "utf8", timeout: 5000,
      }).trim();
      if (resolved) return resolved;
    } catch {}

    throw new Error(
      "claude binary not found. Set CLAUDE_BIN or ensure claude is in PATH."
    );
  }

  _cleanEnv() {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
  }

  _buildCliArgs(cliModel, session) {
    const args = ["-p", "--model", cliModel, "--output-format", "text"];

    if (session?.resume) {
      args.push("--resume", session.uuid);
    } else if (session?.uuid) {
      args.push("--session-id", session.uuid);
    } else {
      args.push("--no-session-persistence");
    }

    if (this._skipPermissions) {
      args.push("--dangerously-skip-permissions");
    } else if (this._allowedTools.length > 0) {
      args.push("--allowedTools", ...this._allowedTools);
    }

    if (this._systemPrompt) {
      args.push("--append-system-prompt", this._systemPrompt);
    }

    if (this._mcpConfig) {
      args.push("--mcp-config", this._mcpConfig);
    }

    return args;
  }

  _getModelTier(cliModel) {
    if (cliModel.includes("opus")) return "opus";
    if (cliModel.includes("haiku")) return "haiku";
    return "sonnet";
  }

  _computeFirstByteTimeout(cliModel, promptLength) {
    const tierName = this._getModelTier(cliModel);
    const tier = this._timeoutTiers[tierName] || this._timeoutTiers.sonnet;
    const timeout = tier.base + Math.floor(promptLength * tier.perPromptChar);
    return Math.min(timeout, Math.max(this._timeout - 5000, 10000));
  }

  /**
   * Convert OpenAI-format messages to a plain text prompt for Claude CLI.
   * Includes truncation guard for oversized prompts.
   */
  _messagesToPrompt(messages, maxChars = 150000) {
    const full = messages.map((m) => {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      if (m.role === "system") return `[System] ${text}`;
      if (m.role === "assistant") return `[Assistant] ${text}`;
      return text;
    });

    const joined = full.join("\n\n");
    if (joined.length <= maxChars) return joined;

    // Truncation: keep system + recent messages
    const system = [];
    const rest = [];
    for (let i = 0; i < full.length; i++) {
      if (messages[i].role === "system") system.push(full[i]);
      else rest.push(full[i]);
    }

    const systemText = system.join("\n\n");
    const budget = maxChars - systemText.length - 200;
    const kept = [];
    let used = 0;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (used + rest[i].length + 2 > budget) break;
      kept.unshift(rest[i]);
      used += rest[i].length + 2;
    }

    const truncNote = `[System] Note: ${rest.length - kept.length} older messages were truncated to fit context limit.`;
    return [systemText, truncNote, ...kept].filter(Boolean).join("\n\n");
  }
}
