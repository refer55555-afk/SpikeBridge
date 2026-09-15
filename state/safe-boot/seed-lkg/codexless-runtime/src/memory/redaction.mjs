const REDACTED = "[REDACTED]";
const SECRET_PATTERNS = [
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, "Bearer [REDACTED]"],
  [/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|cookie|password|passwd|secret)\b\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(\b(?:authorization|proxy-authorization|set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]"],
  [/([^\s"']*auth\.json)/gi, "[REDACTED_AUTH_FILE]"],
  [/\bDPAPI\b[^\r\n]{0,180}/gi, "DPAPI [REDACTED]"],
];

export function redactSecrets(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

