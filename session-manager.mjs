/**
 * SessionManager — manages conversation sessions across requests.
 *
 * Maps caller-provided conversation IDs to backend-specific session state.
 * For Claude CLI, this means mapping to CLI session UUIDs for --resume.
 */

import { randomUUID } from "node:crypto";

export class SessionManager {
  /**
   * @param {Object} options
   * @param {number} [options.ttl=3600000] — Session TTL in ms (default 1h)
   */
  constructor({ ttl = 3600000 } = {}) {
    this._ttl = ttl;
    /** @type {Map<string, SessionEntry>} */
    this._sessions = new Map();

    // Cleanup expired sessions every 60s
    this._cleanupInterval = setInterval(() => this._cleanup(), 60000);
  }

  get ttl() { return this._ttl; }
  set ttl(val) { this._ttl = val; }
  get size() { return this._sessions.size; }

  /**
   * Get or create a session for a conversation.
   *
   * @param {string|null} conversationId
   * @param {string} model — model being used
   * @param {string} [agent] — agent identity
   * @returns {{session: {uuid: string, resume: boolean}, isNew: boolean, isOneOff: boolean}}
   */
  resolve(conversationId, model, agent = "default") {
    if (!conversationId) {
      return { session: null, isNew: false, isOneOff: true };
    }

    if (this._sessions.has(conversationId)) {
      const entry = this._sessions.get(conversationId);
      entry.lastUsed = Date.now();
      entry.messageCount++;
      return {
        session: { uuid: entry.uuid, resume: true },
        isNew: false,
        isOneOff: false,
      };
    }

    // New session
    const uuid = randomUUID();
    this._sessions.set(conversationId, {
      uuid,
      model,
      agent,
      messageCount: 1,
      lastUsed: Date.now(),
      createdAt: Date.now(),
    });

    return {
      session: { uuid, resume: false },
      isNew: true,
      isOneOff: false,
    };
  }

  /**
   * Remove a session (e.g. on resume failure).
   */
  delete(conversationId) {
    this._sessions.delete(conversationId);
  }

  /**
   * Clear all sessions.
   * @returns {number} Number of sessions cleared
   */
  clear() {
    const count = this._sessions.size;
    this._sessions.clear();
    return count;
  }

  /**
   * List all active sessions (for /sessions endpoint).
   */
  list() {
    const result = [];
    for (const [id, s] of this._sessions) {
      result.push({
        id,
        uuid: s.uuid,
        model: s.model,
        agent: s.agent,
        messages: s.messageCount,
        lastUsed: new Date(s.lastUsed).toISOString(),
        idleMs: Date.now() - s.lastUsed,
      });
    }
    return result;
  }

  /**
   * Shutdown — clear interval.
   */
  shutdown() {
    clearInterval(this._cleanupInterval);
  }

  // ── Internal ──────────────────────────────────────────────────────────

  _cleanup() {
    const now = Date.now();
    for (const [id, s] of this._sessions) {
      if (now - s.lastUsed > this._ttl) {
        this._sessions.delete(id);
      }
    }
  }
}
