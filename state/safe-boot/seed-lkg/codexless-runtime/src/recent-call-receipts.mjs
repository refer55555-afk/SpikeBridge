import { randomUUID } from "node:crypto";

export const DEFAULT_RECENT_CALL_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_RECENT_CALL_CAPACITY = 256;
export const DEFAULT_RECENT_CALL_READ_LIMIT = 50;

export function createRecentCallReceiptStore({
  ttlMs = DEFAULT_RECENT_CALL_TTL_MS,
  capacity = DEFAULT_RECENT_CALL_CAPACITY,
  now = () => Date.now(),
  idFactory = () => `rcpt_${randomUUID()}`,
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("recent-call ttlMs must be a positive integer");
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("recent-call capacity must be a positive integer");
  if (typeof now !== "function") throw new Error("recent-call now must be a function");
  if (typeof idFactory !== "function") throw new Error("recent-call idFactory must be a function");

  const entries = [];
  const byId = new Map();

  function prune(atMs = now()) {
    const cutoff = atMs - ttlMs;
    while (entries.length && entries[0]._arrived_ms <= cutoff) {
      const expired = entries.shift();
      byId.delete(expired.receipt_id);
    }
  }

  function arrive(toolName) {
    if (typeof toolName !== "string" || !toolName) throw new Error("recent-call toolName must be a non-empty string");
    const atMs = now();
    prune(atMs);
    while (entries.length >= capacity) {
      const evicted = entries.shift();
      byId.delete(evicted.receipt_id);
    }
    const receiptId = idFactory();
    if (typeof receiptId !== "string" || !receiptId || byId.has(receiptId)) {
      throw new Error("recent-call idFactory must return a unique non-empty string");
    }
    const entry = {
      receipt_id: receiptId,
      tool_name: toolName,
      arrived_at: toIso(atMs),
      handler_started_at: null,
      result_returned_at: null,
      result_class: null,
      status: "arrived",
      error_stage: null,
      error_class: null,
      duration_ms: null,
      _arrived_ms: atMs,
    };
    entries.push(entry);
    byId.set(receiptId, entry);
    return receiptId;
  }

  function markHandlerStarted(receiptId) {
    const entry = byId.get(receiptId);
    if (!entry) return false;
    const atMs = now();
    entry.handler_started_at = toIso(atMs);
    entry.status = "handler_started";
    return true;
  }

  function markResultReturned(receiptId, result) {
    const entry = byId.get(receiptId);
    if (!entry) return false;
    const atMs = now();
    const isToolError = result?.isError === true;
    entry.result_returned_at = toIso(atMs);
    entry.result_class = isToolError ? "tool_error" : "success";
    entry.status = "returned";
    entry.error_stage = isToolError ? "result" : null;
    entry.error_class = isToolError ? "tool_returned_error" : null;
    entry.duration_ms = Math.max(0, atMs - entry._arrived_ms);
    return true;
  }

  function markHandlerError(receiptId, error) {
    const entry = byId.get(receiptId);
    if (!entry) return false;
    const atMs = now();
    entry.result_class = null;
    entry.status = "handler_error";
    entry.error_stage = "handler";
    entry.error_class = safeErrorClass(error);
    entry.duration_ms = Math.max(0, atMs - entry._arrived_ms);
    return true;
  }

  function list({ toolName = null, sinceMs = null, limit = DEFAULT_RECENT_CALL_READ_LIMIT } = {}) {
    const atMs = now();
    prune(atMs);
    if (toolName !== null && (typeof toolName !== "string" || !toolName)) {
      throw new Error("recent-call toolName filter must be null or a non-empty string");
    }
    if (sinceMs !== null && (!Number.isFinite(sinceMs) || sinceMs < 0)) {
      throw new Error("recent-call sinceMs must be null or a non-negative finite number");
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("recent-call limit must be a positive integer");
    }
    const boundedLimit = Math.min(limit, capacity);

    const result = [];
    for (let index = entries.length - 1; index >= 0 && result.length < boundedLimit; index -= 1) {
      const entry = entries[index];
      if (toolName !== null && entry.tool_name !== toolName) continue;
      if (sinceMs !== null && entry._arrived_ms < sinceMs) continue;
      result.push(publicReceipt(entry));
    }
    return result;
  }

  return {
    ttlMs,
    capacity,
    arrive,
    markHandlerStarted,
    markResultReturned,
    markHandlerError,
    list,
  };
}

export function wrapToolHandlerWithRecentCallReceipt({ toolName, handler, store }) {
  if (typeof toolName !== "string" || !toolName) throw new Error("recent-call wrapper requires toolName");
  if (typeof handler !== "function") throw new Error("recent-call wrapper requires handler");
  if (!store) return handler;

  return async function recentCallWrappedHandler(...args) {
    const receiptId = store.arrive(toolName);
    store.markHandlerStarted(receiptId);
    try {
      const result = await handler(...args);
      store.markResultReturned(receiptId, result);
      return result;
    } catch (error) {
      store.markHandlerError(receiptId, error);
      throw error;
    }
  };
}

export function buildRecentCallsDiagnosticPayload(store, {
  toolName = null,
  windowMs = null,
  limit = DEFAULT_RECENT_CALL_READ_LIMIT,
  nowMs = Date.now(),
} = {}) {
  if (!store || typeof store.list !== "function") throw new Error("recent-call diagnostic requires a store");
  const boundedWindowMs = windowMs === null ? store.ttlMs : Math.min(windowMs, store.ttlMs);
  if (!Number.isInteger(boundedWindowMs) || boundedWindowMs < 1) {
    throw new Error("recent-call windowMs must be a positive integer");
  }
  const boundedLimit = Math.min(limit, store.capacity);
  if (!Number.isInteger(boundedLimit) || boundedLimit < 1) {
    throw new Error("recent-call limit must be a positive integer");
  }
  const receipts = store.list({
    toolName,
    sinceMs: Math.max(0, nowMs - boundedWindowMs),
    limit: boundedLimit,
  });
  return {
    ok: true,
    ttl_ms: store.ttlMs,
    capacity: store.capacity,
    returned: receipts.length,
    filter: {
      tool_name: toolName,
      window_ms: boundedWindowMs,
      limit: boundedLimit,
    },
    semantics: {
      arrived_at:
        "A receipt exists only when Codexless entered the registered tool handler callback. It proves a server-side arrival at Codexless dispatch, not that the caller received the result.",
      no_match:
        "No matching server-arrival receipt was found in this bounded in-memory window. This does not prove that the host did not send the call.",
      privacy:
        "Receipts contain metadata only. Tool arguments, prompts/messages, file contents, URL bodies, secrets/tokens/keys, and stdout/stderr bodies are not recorded.",
    },
    receipts,
  };
}

function publicReceipt(entry) {
  return {
    receipt_id: entry.receipt_id,
    tool_name: entry.tool_name,
    arrived_at: entry.arrived_at,
    handler_started_at: entry.handler_started_at,
    result_returned_at: entry.result_returned_at,
    result_class: entry.result_class,
    status: entry.status,
    error_stage: entry.error_stage,
    error_class: entry.error_class,
    duration_ms: entry.duration_ms,
  };
}

function safeErrorClass(error) {
  const candidates = [error?.code, error?.name, error?.constructor?.name];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (/^[A-Za-z0-9_.:-]{1,80}$/.test(normalized)) return normalized;
  }
  return "Error";
}

function toIso(ms) {
  return new Date(ms).toISOString();
}
