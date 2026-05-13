// src/http-client.ts
import kayba, { SpanType } from "@kayba_ai/tracing";
var OrchestratorRateLimitError = class extends Error {
  code = "RATE_LIMIT_EXCEEDED";
  retryAfterMs;
  status;
  constructor(message, retryAfterMs, status) {
    super(message);
    this.name = "OrchestratorRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
};
function parseRetryAfterMs(headerValue, maxMs) {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(Math.round(asSeconds * 1e3), maxMs);
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    return Math.max(0, Math.min(asDate - Date.now(), maxMs));
  }
  return null;
}
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t && typeof t === "object" && "unref" in t) {
      t.unref();
    }
  });
}
async function orchestratorRequest(opts) {
  if (!kayba.isConfigured()) {
    return doRequest(opts);
  }
  const span = kayba.startSpan({
    name: `HTTP ${opts.method} ${opts.path}`,
    spanType: SpanType.TOOL,
    inputs: { method: opts.method, path: opts.path }
  });
  try {
    const result = await doRequest(opts);
    span.end({ outputs: { status: "ok" }, status: "OK" });
    return result;
  } catch (err) {
    span.end({
      outputs: { error: err instanceof Error ? err.message : String(err) },
      status: "ERROR"
    });
    throw err;
  }
}
async function doRequest(opts, isRetry = false, rateLimitAttempt = 0) {
  const url = `${opts.baseUrl.replace(/\/$/, "")}${opts.path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    opts.timeout ?? 12e4
  );
  try {
    const headers = {
      "Content-Type": "application/json"
    };
    const bearer = opts.accessToken || opts.apiKey;
    if (bearer) {
      headers["Authorization"] = `Bearer ${bearer}`;
    }
    if (opts.extraHeaders) {
      Object.assign(headers, opts.extraHeaders);
    }
    const fetchOpts = {
      method: opts.method,
      headers,
      signal: controller.signal
    };
    if ((opts.method === "POST" || opts.method === "PUT" || opts.method === "PATCH") && opts.body) {
      fetchOpts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, fetchOpts);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    const dataObj = data && typeof data === "object" && !Array.isArray(data) ? data : null;
    if (res.status === 403 && dataObj?.code === "ACCESS_LIMIT_REACHED") {
      clearTimeout(timeoutId);
      const msg = typeof dataObj.message === "string" && dataObj.message.trim() ? dataObj.message : "Access limit reached.";
      throw new Error(msg);
    }
    if ((res.status === 401 || res.status === 403) && !isRetry && opts.onUnauthorized) {
      clearTimeout(timeoutId);
      const newToken = await opts.onUnauthorized();
      return doRequest({ ...opts, accessToken: newToken }, true, rateLimitAttempt);
    }
    const bodyCodeIsRateLimit = typeof dataObj?.code === "string" && /\bRATE_LIMIT\b/i.test(dataObj.code);
    const isRateLimited = res.status === 429 || !res.ok && bodyCodeIsRateLimit;
    if (isRateLimited) {
      clearTimeout(timeoutId);
      const maxWait = opts.rateLimitMaxRetryWaitMs ?? 3e4;
      const maxRetries = opts.rateLimitMaxRetries ?? 1;
      const retryAfter = parseRetryAfterMs(res.headers.get("Retry-After"), maxWait) ?? Math.min(maxWait, 1e3 * Math.pow(2, rateLimitAttempt));
      const bodyMessage = typeof dataObj?.message === "string" ? dataObj.message : typeof dataObj?.error === "string" ? dataObj.error : `HTTP ${res.status}`;
      if (rateLimitAttempt < maxRetries) {
        await sleep(retryAfter);
        return doRequest(opts, isRetry, rateLimitAttempt + 1);
      }
      throw new OrchestratorRateLimitError(
        `RATE_LIMIT_EXCEEDED: ${bodyMessage}`,
        retryAfter,
        res.status
      );
    }
    if (!res.ok) {
      const errBody = data && typeof data === "object" && !Array.isArray(data) ? data : null;
      const errCode = typeof errBody?.code === "string" ? errBody.code : null;
      const errText = typeof errBody?.message === "string" ? errBody.message : typeof errBody?.error === "string" ? errBody.error : `HTTP ${res.status}: ${text.slice(0, 200)}`;
      const errMsg = errCode ? `${errCode}: ${errText}` : errText;
      throw new Error(errMsg);
    }
    return data;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Orchestrator request timed out after ${opts.timeout ?? 3e4}ms: ${opts.method} ${opts.path}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export {
  OrchestratorRateLimitError,
  orchestratorRequest
};
