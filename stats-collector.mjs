/**
 * StatsCollector — tracks request metrics per-model, per-backend, per-agent.
 *
 * Replaces the flat stats + modelStats from server.mjs with structured,
 * multi-dimensional tracking. Backward compatible: still exposes the same
 * data for /health, /usage, /status endpoints.
 */

export class StatsCollector {
  constructor() {
    // Global counters (backward compatible)
    this.totalRequests = 0;
    this.activeRequests = 0;
    this.errors = 0;
    this.timeouts = 0;
    this.sessionHits = 0;
    this.sessionMisses = 0;
    this.oneOffRequests = 0;

    // Recent errors ring buffer
    this._recentErrors = [];
    this._maxErrors = 20;

    /** @type {Map<string, ModelStats>} cliModel → stats */
    this._modelStats = new Map();

    /** @type {Map<string, ModelStats>} backendId → stats */
    this._backendStats = new Map();

    /** @type {Map<string, ModelStats>} agentName → stats */
    this._agentStats = new Map();
  }

  /**
   * Record a new request starting.
   */
  recordRequest(model, backend, agent, promptChars) {
    this.totalRequests++;
    this.activeRequests++;
    this._getOrCreate(this._modelStats, model).recordRequest(promptChars);
    this._getOrCreate(this._backendStats, backend).recordRequest(promptChars);
    this._getOrCreate(this._agentStats, agent).recordRequest(promptChars);
  }

  /**
   * Record a successful completion.
   */
  recordSuccess(model, backend, agent, elapsedMs, cost = null) {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this._getOrCreate(this._modelStats, model).recordSuccess(elapsedMs, cost);
    this._getOrCreate(this._backendStats, backend).recordSuccess(elapsedMs, cost);
    this._getOrCreate(this._agentStats, agent).recordSuccess(elapsedMs, cost);
  }

  /**
   * Record an error.
   */
  recordError(model, backend, agent, isTimeout, message = "") {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.errors++;
    if (isTimeout) this.timeouts++;

    this._getOrCreate(this._modelStats, model).recordError(isTimeout);
    this._getOrCreate(this._backendStats, backend).recordError(isTimeout);
    this._getOrCreate(this._agentStats, agent).recordError(isTimeout);

    this._recentErrors.push({
      time: new Date().toISOString(),
      message: String(message).slice(0, 200),
      model, backend, agent,
    });
    if (this._recentErrors.length > this._maxErrors) this._recentErrors.shift();
  }

  /**
   * Record session hit/miss/one-off.
   */
  recordSessionHit() { this.sessionHits++; }
  recordSessionMiss() { this.sessionMisses++; }
  recordOneOff() { this.oneOffRequests++; }

  /**
   * Get per-model stats snapshot (backward compatible with v2).
   */
  getModelStatsSnapshot() {
    return this._snapshot(this._modelStats);
  }

  /**
   * Get per-backend stats snapshot.
   */
  getBackendStatsSnapshot() {
    return this._snapshot(this._backendStats);
  }

  /**
   * Get per-agent stats snapshot.
   */
  getAgentStatsSnapshot() {
    return this._snapshot(this._agentStats);
  }

  /**
   * Get recent errors.
   */
  getRecentErrors(n = 5) {
    return this._recentErrors.slice(-n);
  }

  /**
   * Get global stats (backward compatible).
   */
  getGlobalStats() {
    return {
      totalRequests: this.totalRequests,
      activeRequests: this.activeRequests,
      errors: this.errors,
      timeouts: this.timeouts,
      sessionHits: this.sessionHits,
      sessionMisses: this.sessionMisses,
      oneOffRequests: this.oneOffRequests,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────

  _getOrCreate(map, key) {
    if (!map.has(key)) map.set(key, new ModelStats());
    return map.get(key);
  }

  _snapshot(map) {
    const result = {};
    for (const [key, stats] of map) {
      result[key] = stats.toJSON();
    }
    return result;
  }
}

/** Per-entity stats tracker */
class ModelStats {
  constructor() {
    this.requests = 0;
    this.successes = 0;
    this.errors = 0;
    this.timeouts = 0;
    this.totalElapsed = 0;
    this.maxElapsed = 0;
    this.totalPromptChars = 0;
    this.maxPromptChars = 0;
    this.totalCost = 0; // accumulated estimated/actual cost
  }

  recordRequest(promptChars) {
    this.requests++;
    this.totalPromptChars += promptChars;
    if (promptChars > this.maxPromptChars) this.maxPromptChars = promptChars;
  }

  recordSuccess(elapsedMs, cost = null) {
    this.successes++;
    this.totalElapsed += elapsedMs;
    if (elapsedMs > this.maxElapsed) this.maxElapsed = elapsedMs;
    if (cost?.value) this.totalCost += cost.value;
  }

  recordError(isTimeout) {
    this.errors++;
    if (isTimeout) this.timeouts++;
  }

  toJSON() {
    return {
      requests: this.requests,
      successes: this.successes,
      errors: this.errors,
      timeouts: this.timeouts,
      avgElapsed: this.successes > 0 ? Math.round(this.totalElapsed / this.successes) : 0,
      maxElapsed: this.maxElapsed,
      avgPromptChars: this.requests > 0 ? Math.round(this.totalPromptChars / this.requests) : 0,
      maxPromptChars: this.maxPromptChars,
      totalCost: Math.round(this.totalCost * 10000) / 10000, // 4 decimal places
    };
  }
}
