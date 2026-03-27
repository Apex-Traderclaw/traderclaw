// src/tool-envelope.ts
var ERROR_CLASSIFICATION = {
  ECONNREFUSED: { retryable: true, code: "NETWORK_ERROR" },
  ECONNRESET: { retryable: true, code: "NETWORK_ERROR" },
  ETIMEDOUT: { retryable: true, code: "TIMEOUT" },
  ENOTFOUND: { retryable: false, code: "DNS_ERROR" },
  AbortError: { retryable: true, code: "TIMEOUT" },
  "timed out": { retryable: true, code: "TIMEOUT" },
  "rate limit": { retryable: true, code: "RATE_LIMIT" },
  "429": { retryable: true, code: "RATE_LIMIT" },
  "401": { retryable: false, code: "AUTH_ERROR" },
  "403": { retryable: false, code: "AUTH_ERROR" },
  "404": { retryable: false, code: "NOT_FOUND" },
  "500": { retryable: true, code: "SERVER_ERROR" },
  "502": { retryable: true, code: "SERVER_ERROR" },
  "503": { retryable: true, code: "SERVER_ERROR" }
};
function generateTraceId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `tc-${ts}-${rand}`;
}
function classifyError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  for (const [pattern, classification] of Object.entries(ERROR_CLASSIFICATION)) {
    if (msg.includes(pattern)) {
      return { ...classification, message: msg };
    }
  }
  if (msg.toLowerCase().includes("session expired") || msg.toLowerCase().includes("re-authenticate")) {
    return { code: "SESSION_EXPIRED", retryable: false, message: msg };
  }
  if (msg.toLowerCase().includes("insufficient") || msg.toLowerCase().includes("balance")) {
    return { code: "INSUFFICIENT_FUNDS", retryable: false, message: msg };
  }
  return { code: "UNKNOWN_ERROR", retryable: false, message: msg };
}
function normalizeToolSuccess(data, source) {
  return {
    ok: true,
    data,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    source,
    traceId: generateTraceId()
  };
}
function normalizeToolError(err, source) {
  const classified = classifyError(err);
  return {
    ok: false,
    data: null,
    errorCode: classified.code,
    errorMessage: classified.message,
    retryable: classified.retryable,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    source,
    traceId: generateTraceId()
  };
}
function renderToolEnvelope(envelope) {
  if (envelope.ok) {
    return JSON.stringify({
      ok: true,
      data: envelope.data,
      source: envelope.source,
      generatedAt: envelope.generatedAt,
      traceId: envelope.traceId
    });
  }
  return JSON.stringify({
    ok: false,
    errorCode: envelope.errorCode,
    errorMessage: envelope.errorMessage,
    retryable: envelope.retryable,
    source: envelope.source,
    generatedAt: envelope.generatedAt,
    traceId: envelope.traceId
  });
}
async function envelopedExecute(toolName, fn) {
  try {
    const result = await fn();
    return renderToolEnvelope(normalizeToolSuccess(result, toolName));
  } catch (err) {
    return renderToolEnvelope(normalizeToolError(err, toolName));
  }
}

export {
  normalizeToolSuccess,
  normalizeToolError,
  renderToolEnvelope,
  envelopedExecute
};
