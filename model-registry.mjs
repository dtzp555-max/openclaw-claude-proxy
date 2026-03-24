/**
 * Model Registry — Layer 1 of OCP routing.
 *
 * Static mapping: model ID → backend ID.
 * This is infrastructure, not policy. Every model must map to exactly one backend.
 *
 * Non-agent callers (Cline, Aider, etc.) only send a model name — this module
 * is the only thing that tells OCP where to route the request.
 */

export class ModelRegistry {
  constructor() {
    /** @type {Map<string, {backendId: string, canonical: string}>} */
    this._models = new Map();

    /** @type {Map<string, Object>} model id → display metadata */
    this._metadata = new Map();
  }

  /**
   * Register models from a backend adapter.
   * Called during startup for each enabled backend.
   *
   * @param {import("./backends/base.mjs").BackendAdapter} adapter
   */
  registerBackend(adapter) {
    for (const modelId of adapter.models) {
      this._models.set(modelId, {
        backendId: adapter.id,
        canonical: modelId,
      });
      this._metadata.set(modelId, {
        backendId: adapter.id,
        backendName: adapter.displayName,
        tier: adapter.tier,
        costType: adapter.costType,
      });
    }

    // Also register aliases if the adapter supports resolveModel
    if (typeof adapter.resolveModel === "function") {
      // We don't auto-register aliases here — they're handled by
      // supportsModel() on the adapter. The registry only knows canonical IDs.
    }
  }

  /**
   * Look up which backend serves a given model.
   *
   * @param {string} model — model ID (could be canonical or alias)
   * @returns {{backendId: string, canonical: string} | null}
   */
  resolve(model) {
    // Direct lookup first
    const direct = this._models.get(model);
    if (direct) return direct;

    // No alias resolution here — that's the adapter's job.
    // The router will ask each adapter if it supports the model.
    return null;
  }

  /**
   * Get all registered models with metadata.
   * Used by GET /v1/models endpoint.
   */
  listModels() {
    const result = [];
    for (const [id, meta] of this._metadata) {
      result.push({ id, ...meta });
    }
    return result;
  }

  /**
   * Check if a model is known to the registry.
   */
  has(model) {
    return this._models.has(model);
  }

  /**
   * Get the backend ID for a model, or null.
   */
  getBackendId(model) {
    return this._models.get(model)?.backendId || null;
  }

  /**
   * Get all models for a specific backend.
   */
  getModelsForBackend(backendId) {
    const models = [];
    for (const [id, entry] of this._models) {
      if (entry.backendId === backendId) models.push(id);
    }
    return models;
  }
}
