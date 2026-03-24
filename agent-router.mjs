/**
 * Agent Router — Layer 2 of OCP routing.
 *
 * Routing decision order (written in stone):
 *   1. Agent policy override  → agent has explicit backend config? Use it.
 *   2. Model registry         → model maps to a backend? Route there.
 *   3. Default backend        → global fallback.
 *   4. Fallback chain         → chosen backend is down? Try next.
 *
 * Agent identity sources (priority):
 *   1. x-ocp-agent header
 *   2. Session metadata (bound on first request)
 *   3. (future) Inferred from usage patterns
 *   4. "default"
 */

export class AgentRouter {
  /**
   * @param {Object} options
   * @param {import("./model-registry.mjs").ModelRegistry} options.registry
   * @param {Map<string, import("./backends/base.mjs").BackendAdapter>} options.backends
   * @param {Object} options.agentConfig — agent routing rules from config
   * @param {string} options.defaultBackend — fallback backend ID
   */
  constructor({ registry, backends, agentConfig = {}, defaultBackend = "claude-cli" }) {
    this._registry = registry;
    this._backends = backends;
    this._agentConfig = agentConfig;
    this._defaultBackend = defaultBackend;
  }

  /**
   * Identify the agent from a request.
   *
   * @param {Object} req - HTTP request
   * @param {Object} [sessionMeta] - Session metadata (may contain agent binding)
   * @returns {string} Agent name
   */
  identifyAgent(req, sessionMeta = null) {
    // 1. Explicit header
    const headerAgent = req.headers?.["x-ocp-agent"];
    if (headerAgent) return headerAgent;

    // 2. Session binding
    if (sessionMeta?.agent) return sessionMeta.agent;

    // 3. (future) Inferred — not implemented yet

    // 4. Default
    return "default";
  }

  /**
   * Resolve which backend + model to use for a request.
   *
   * @param {Object} params
   * @param {string} params.agent - Agent name (from identifyAgent)
   * @param {string} params.model - Requested model ID
   * @returns {{backendId: string, model: string, reason: string}}
   */
  resolve({ agent, model }) {
    // Step 1: Agent policy override
    const agentRule = this._agentConfig[agent];
    if (agentRule?.preferred) {
      const { backendId, modelId } = this._parsePreferred(agentRule.preferred);
      const backend = this._backends.get(backendId);
      if (backend?.enabled) {
        const resolvedModel = modelId || model;
        return {
          backendId,
          model: resolvedModel,
          reason: `agent-policy(${agent})`,
        };
      }
      // Agent preferred backend is down — try fallback
      if (agentRule.fallback) {
        const fb = this._parseFallback(agentRule.fallback, model);
        if (fb) return { ...fb, reason: `agent-fallback(${agent})` };
      }
    }

    // Step 2: Model registry
    const registryEntry = this._registry.resolve(model);
    if (registryEntry) {
      const backend = this._backends.get(registryEntry.backendId);
      if (backend?.enabled) {
        return {
          backendId: registryEntry.backendId,
          model: registryEntry.canonical,
          reason: "model-registry",
        };
      }
    }

    // Step 2b: Check adapters for alias support
    for (const [id, backend] of this._backends) {
      if (backend.enabled && backend.supportsModel(model)) {
        const resolved = typeof backend.resolveModel === "function"
          ? backend.resolveModel(model)
          : model;
        return {
          backendId: id,
          model: resolved,
          reason: `adapter-match(${id})`,
        };
      }
    }

    // Step 3: Default backend
    const defaultAgent = this._agentConfig.default;
    if (defaultAgent?.preferred) {
      const { backendId } = this._parsePreferred(defaultAgent.preferred);
      if (this._backends.get(backendId)?.enabled) {
        return { backendId, model, reason: "default-agent-policy" };
      }
    }

    if (this._backends.get(this._defaultBackend)?.enabled) {
      return {
        backendId: this._defaultBackend,
        model,
        reason: "default-backend",
      };
    }

    // Step 4: Fallback — try any enabled backend
    for (const [id, backend] of this._backends) {
      if (backend.enabled) {
        return { backendId: id, model, reason: `last-resort(${id})` };
      }
    }

    return { backendId: null, model, reason: "no-backend-available" };
  }

  /**
   * Parse a preferred string like "claude-cli" or "claude-cli/claude-opus-4-6"
   */
  _parsePreferred(preferred) {
    if (preferred.includes("/")) {
      const [backendId, modelId] = preferred.split("/", 2);
      return { backendId, modelId };
    }
    return { backendId: preferred, modelId: null };
  }

  /**
   * Parse a fallback value and return routing info.
   */
  _parseFallback(fallback, model) {
    if (!fallback) return null;
    const { backendId, modelId } = this._parsePreferred(fallback);
    const backend = this._backends.get(backendId);
    if (!backend?.enabled) return null;
    return { backendId, model: modelId || model };
  }

  /**
   * Get routing info for display (e.g. /ocp routing command).
   */
  getRoutingTable() {
    const table = {};
    for (const [agent, config] of Object.entries(this._agentConfig)) {
      table[agent] = {
        preferred: config.preferred || null,
        fallback: config.fallback || null,
      };
    }
    return table;
  }
}
