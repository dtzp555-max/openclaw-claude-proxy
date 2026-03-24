/**
 * UnifiedChunk — the internal streaming protocol for OCP.
 *
 * All backend adapters MUST convert their native output into this format.
 * server.mjs only handles UnifiedChunks → OpenAI SSE conversion.
 */

/**
 * @typedef {Object} UnifiedChunk
 * @property {"delta"|"done"|"error"} type
 * @property {string} [content]       — text content (for "delta")
 * @property {string} model           — canonical model id
 * @property {string} backend         — backend id (e.g. "claude-cli")
 * @property {Object} [usage]         — token usage (for "done")
 * @property {number} [usage.promptTokens]
 * @property {number} [usage.completionTokens]
 * @property {Object} [cost]          — cost info (for "done")
 * @property {number} [cost.value]
 * @property {"actual"|"estimated"|"free"} [cost.type]
 * @property {string} [error]         — error message (for "error")
 */

/**
 * Create a delta chunk (streaming content)
 */
export function delta(content, model, backend) {
  return { type: "delta", content, model, backend };
}

/**
 * Create a done chunk (stream finished)
 */
export function done(model, backend, usage = null, cost = null) {
  return { type: "done", model, backend, ...(usage && { usage }), ...(cost && { cost }) };
}

/**
 * Create an error chunk
 */
export function error(message, model, backend) {
  return { type: "error", error: message, model, backend };
}
