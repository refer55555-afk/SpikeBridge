import os from "node:os";
import { redactSecrets } from "./redaction.mjs";

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?\b/g;
const CLOCK_RE = /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const PID_RE = /\b(?:pid|process(?:Id)?|child(?:Pid)?)\s*[=:]\s*\d+\b/gi;
const SESSION_RE = /\b(?:session|task|job|request|turn|thread)[_-]?(?:id|ref)?\s*[=:]\s*[A-Za-z0-9._:-]{8,}\b/gi;
const TEMP_WIN_RE = /[A-Za-z]:\\(?:Users\\[^\\]+\\AppData\\Local\\Temp|Windows\\Temp|Temp)\\[^\s"']+/gi;
const TEMP_POSIX_RE = /\/(?:tmp|var\/tmp)\/[^\s"']+/g;
const HEXISH_RE = /\b[0-9a-f]{24,}\b/gi;
const LONG_NUM_RE = /\b\d{7,}\b/g;

const KNOWN = [
  [/(?:httpx|fetch|proxy)[^\n]{0,120}\b502\b|\b502\b[^\n]{0,120}(?:localhost|127\.0\.0\.1)/i, "localhost_httpx_502"],
  [/createprocesswithlogonw[^\n]{0,100}(?:failed|error)[^\n]{0,40}\b2\b/i, "windows_createprocesswithlogonw_2"],
  [/browser_tabs[^\n]{0,120}(?:fetch_failed|fetch failed|unavailable)/i, "browser_tabs_fetch_failed"],
  [/node_repl[^\n]{0,120}(?:fetch_failed|fetch failed|unavailable|not connected)/i, "node_repl_unavailable"],
  [/too many requests|\b429\b/i, "http_429_rate_limit"],
  [/econnrefused[^\n]{0,100}(?:127\.0\.0\.1|localhost)/i, "localhost_econnrefused"],
  [/econnreset/i, "econnreset"],
  [/etimedout|timed out|timeout/i, "timeout"],
];

function normPart(value, fallback = "unknown") {
  const text = redactSecrets(value).trim().toLowerCase();
  if (!text) return fallback;
  return text.replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || fallback;
}

export function normalizeFailureText(value) {
  return redactSecrets(value)
    .replace(ISO_TS_RE, "<ts>")
    .replace(CLOCK_RE, "<time>")
    .replace(UUID_RE, "<uuid>")
    .replace(PID_RE, "pid=<pid>")
    .replace(SESSION_RE, "session=<id>")
    .replace(TEMP_WIN_RE, "<temp_path>")
    .replace(TEMP_POSIX_RE, "<temp_path>")
    .replace(HEXISH_RE, "<hex>")
    .replace(LONG_NUM_RE, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

function stableTokens(text) {
  const ignored = new Set([
    "error", "failed", "failure", "the", "and", "for", "with", "from", "that", "this", "into", "when", "while",
    "redacted", "unknown", "null", "true", "false", "code", "status", "process", "pid", "request", "response", "message", "result",
  ]);
  const tokens = String(text ?? "").toLowerCase().match(/[a-z][a-z0-9_.:-]{2,}|[\p{L}]{2,}/gu) ?? [];
  const out = [];
  for (const raw of tokens) {
    const token = raw.replace(/^[-_.:]+|[-_.:]+$/g, "");
    if (!token || ignored.has(token) || token.includes("<")) continue;
    if (!out.includes(token)) out.push(token);
    if (out.length >= 8) break;
  }
  return out;
}

export function detectKnownFailureId(text) {
  const normalized = normalizeFailureText(text);
  for (const [pattern, id] of KNOWN) {
    if (pattern.test(normalized)) return id;
  }
  return null;
}

export function normalizeFailureSignature({
  provider = null,
  tool = null,
  platform = process.platform || os.platform(),
  httpStatus = null,
  exitCode = null,
  errorClass = null,
  errorCode = null,
  stderr = null,
  message = null,
  knownId = null,
} = {}) {
  const combined = normalizeFailureText([message, stderr, errorCode, errorClass].filter(Boolean).join(" | "));
  const detected = knownId || detectKnownFailureId(combined);
  if (detected) return normPart(detected);

  const parts = [];
  if (provider) parts.push(normPart(provider));
  if (tool) parts.push(normPart(tool));
  if (platform) parts.push(normPart(platform));
  if (httpStatus !== null && httpStatus !== undefined) parts.push(`http_${normPart(httpStatus)}`);
  if (exitCode !== null && exitCode !== undefined) parts.push(`exit_${normPart(exitCode)}`);
  if (errorClass) parts.push(normPart(errorClass));
  if (errorCode) parts.push(normPart(errorCode));
  parts.push(...stableTokens(combined).map(normPart));
  if (parts.length === 0) parts.push("unknown_failure");
  return parts.slice(0, 12).join("|").slice(0, 512);
}

export function failureFromError(error, context = {}) {
  const value = error && typeof error === "object" ? error : {};
  return normalizeFailureSignature({
    ...context,
    errorClass: value?.name ?? context.errorClass,
    errorCode: value?.code ?? context.errorCode,
    message: value?.message ?? String(error ?? context.message ?? ""),
    stderr: context.stderr,
    httpStatus: context.httpStatus ?? value?.status ?? value?.statusCode,
    exitCode: context.exitCode ?? value?.exitCode,
  });
}
 
