const ALLOWED_QUERY_KEYS = new Set(["receipt_id", "tool_name", "status", "since", "limit"]);
const ALLOWED_STATUSES = new Set(["arrived", "handler_started", "returned", "handler_error"]);

export function handleRecentCallHttpRequest({ req, res, url, diagnostics }) {
  if (url.pathname !== "/internal/recent-calls") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
    return true;
  }
  try {
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED_QUERY_KEYS.has(key)) throw new QueryError(`unsupported query parameter: ${key}`);
    }
    const receiptId = boundedString(url.searchParams.get("receipt_id"), "receipt_id", 256);
    const toolName = boundedString(url.searchParams.get("tool_name"), "tool_name", 512);
    const status = boundedString(url.searchParams.get("status"), "status", 64);
    if (status && !ALLOWED_STATUSES.has(status)) throw new QueryError("invalid status filter");
    const since = boundedString(url.searchParams.get("since"), "since", 128);
    const limitRaw = boundedString(url.searchParams.get("limit"), "limit", 8);
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    const result = diagnostics.query({ receiptId, toolName, status, since, limit });
    sendJson(res, 200, result);
  } catch (error) {
    const statusCode = error instanceof QueryError || /limit must|since must/i.test(error instanceof Error ? error.message : "") ? 400 : 503;
    sendJson(res, statusCode, {
      error: statusCode === 400 ? "invalid_query" : "diagnostics_unavailable",
      error_class: safeHttpErrorClass(error),
    });
  }
  return true;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function boundedString(value, name, maxLength) {
  if (value === null) return null;
  if (!value || value.length > maxLength) throw new QueryError(`${name} is invalid`);
  return value;
}

function safeHttpErrorClass(error) {
  const name = error && typeof error === "object" && typeof error.name === "string" ? error.name : "Error";
  return name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Error";
}

class QueryError extends Error {}
