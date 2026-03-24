/**
 * BackendAdapter — base class for all OCP backends.
 *
 * Each backend adapter MUST:
 * 1. Implement chatCompletion() as an async generator yielding UnifiedChunks
 * 2. Implement healthCheck()
 * 3. Report its costType (actual | estimated | free)
 * 4. Report its tier (core | community)
 *
 * Adapters do NOT handle:
 * - Session management (SessionManager does that)
 * - Stats collection (StatsCollector does that)
 * - Routing decisions (agent-router does that)
 */

export class BackendAdapter {
  /**
   * @param {Object} config - Backend-specific configuration
   */
  constructor(config = {}) {
    this._config = config;
    this._enabled = config.enabled !== false;
  }

  /** @returns {string} Unique backend identifier */
  get id() { throw new Error("BackendAdapter.id must be implemented"); }

  /** @returns {string} Human-readable name */
  get displayName() { throw new Error("BackendAdapter.displayName must be implemented"); }

  /** @returns {string[]} List of supported model IDs */
  get models() { throw new Error("BackendAdapter.models must be implemented"); }

  /** @returns {"actual"|"estimated"|"free"} */
  get costType() { throw new Error("BackendAdapter.costType must be implemented"); }

  /** @returns {"core"|"community"} */
  get tier() { return "core"; }

  /** @returns {boolean} */
  get enabled() { return this._enabled; }

  /**
   * Initialize the backend (called once at startup).
   * Override to do async setup (e.g. validate binary, check API key).
   */
  async initialize() {}

  /**
   * Shutdown the backend (called on graceful shutdown).
   * Override to clean up resources.
   */
  async shutdown() {}

  /**
   * Check if this backend is healthy and reachable.
   * @returns {Promise<{ok: boolean, message: string, latencyMs: number}>}
   */
  async healthCheck() {
    return { ok: false, message: "healthCheck not implemented", latencyMs: 0 };
  }

  /**
   * Execute a chat completion request.
   *
   * MUST yield UnifiedChunk objects:
   *   { type: "delta", content: "...", model, backend }  — streaming content
   *   { type: "done", model, backend, usage?, cost? }    — stream finished
   *   { type: "error", error: "...", model, backend }    — error occurred
   *
   * @param {Object} request
   * @param {string} request.model - Canonical model ID
   * @param {Array}  request.messages - OpenAI-format messages array
   * @param {Object} [request.session] - Session info { uuid, resume }
   * @param {Object} [request.options] - Additional options (temperature, etc.)
   * @yields {import("../unified-chunk.mjs").UnifiedChunk}
   */
  async *chatCompletion(request) {
    throw new Error("BackendAdapter.chatCompletion must be implemented");
  }

  /**
   * Check if this backend supports a given model.
   * Default: exact match against models list.
   * Override for pattern matching (e.g. "gpt-*" → openai).
   */
  supportsModel(model) {
    return this.models.includes(model);
  }
}
