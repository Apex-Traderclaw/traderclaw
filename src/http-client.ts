import kayba, { SpanType } from "@kayba_ai/tracing";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface OrchestratorRequestOptions {
  baseUrl: string;
  method: HttpMethod;
  path: string;
  body?: Record<string, unknown>;
  timeout?: number;
  accessToken?: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  onUnauthorized?: () => Promise<string>;
  /**
   * Maximum number of automatic retries on HTTP 429 (Rate-Limit) responses.
   * Each retry waits for the duration indicated by `Retry-After` (capped by
   * `rateLimitMaxRetryWaitMs`) and uses exponential fallback when the header
   * is absent. Defaults to 1. Set to 0 to disable automatic backoff.
   */
  rateLimitMaxRetries?: number;
  /**
   * Upper bound (ms) for the wait inserted before retrying a 429.
   * Defaults to 30_000 ms.
   */
  rateLimitMaxRetryWaitMs?: number;
}

/**
 * Thrown when the orchestrator returns HTTP 429 (or a body with code
 * `RATE_LIMIT_EXCEEDED`) and the request has exhausted its automatic
 * retry budget. Carries the parsed wait hint so callers can pause their
 * own work (rather than fanning out further). The `code` field matches
 * `isOrchestratorRateLimitError()` in `index.ts`.
 */
export class OrchestratorRateLimitError extends Error {
  readonly code = "RATE_LIMIT_EXCEEDED" as const;
  readonly retryAfterMs: number | null;
  readonly status: number;
  constructor(message: string, retryAfterMs: number | null, status: number) {
    super(message);
    this.name = "OrchestratorRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

/**
 * Parse `Retry-After` per RFC 7231: integer seconds OR an HTTP-date.
 * Returns ms (clamped to 0..maxMs) or null when the header is absent /
 * unparseable.
 */
function parseRetryAfterMs(headerValue: string | null, maxMs: number): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(Math.round(asSeconds * 1000), maxMs);
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    return Math.max(0, Math.min(asDate - Date.now(), maxMs));
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t && typeof t === "object" && "unref" in t) {
      (t as NodeJS.Timeout).unref();
    }
  });
}

export async function orchestratorRequest(
  opts: OrchestratorRequestOptions,
): Promise<unknown> {
  if (!kayba.isConfigured()) {
    return doRequest(opts);
  }

  const span = kayba.startSpan({
    name: `HTTP ${opts.method} ${opts.path}`,
    spanType: SpanType.TOOL,
    inputs: { method: opts.method, path: opts.path },
  });

  try {
    const result = await doRequest(opts);
    span.end({ outputs: { status: "ok" }, status: "OK" });
    return result;
  } catch (err) {
    span.end({
      outputs: { error: err instanceof Error ? err.message : String(err) },
      status: "ERROR",
    });
    throw err;
  }
}

async function doRequest(
  opts: OrchestratorRequestOptions,
  isRetry = false,
  rateLimitAttempt = 0,
): Promise<unknown> {
  const url = `${opts.baseUrl.replace(/\/$/, "")}${opts.path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    opts.timeout ?? 120000,
  );

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const bearer = opts.accessToken || opts.apiKey;
    if (bearer) {
      headers["Authorization"] = `Bearer ${bearer}`;
    }
    if (opts.extraHeaders) {
      Object.assign(headers, opts.extraHeaders);
    }

    const fetchOpts: RequestInit = {
      method: opts.method,
      headers,
      signal: controller.signal,
    };

    if ((opts.method === "POST" || opts.method === "PUT" || opts.method === "PATCH") && opts.body) {
      fetchOpts.body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, fetchOpts);
    const text = await res.text();

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    const dataObj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;

    if (res.status === 403 && dataObj?.code === "ACCESS_LIMIT_REACHED") {
      clearTimeout(timeoutId);
      const msg =
        typeof dataObj.message === "string" && dataObj.message.trim()
          ? dataObj.message
          : "Access limit reached.";
      throw new Error(msg);
    }

    if ((res.status === 401 || res.status === 403) && !isRetry && opts.onUnauthorized) {
      clearTimeout(timeoutId);
      const newToken = await opts.onUnauthorized();
      return doRequest({ ...opts, accessToken: newToken }, true, rateLimitAttempt);
    }

    // ── Rate limit handling ──────────────────────────────────────────────
    // The orchestrator signals rate limiting via HTTP 429 OR a JSON body
    // with code `RATE_LIMIT_EXCEEDED` on a non-2xx status. Respect
    // `Retry-After` (seconds or HTTP-date) when present, otherwise use
    // exponential fallback (1s, 2s, 4s, ...) capped by
    // `rateLimitMaxRetryWaitMs`. We retry at most once by default to
    // smooth transient throttling without amplifying load when the
    // orchestrator is genuinely overwhelmed. When the retry budget is
    // exhausted we throw `OrchestratorRateLimitError` so callers can
    // pause their own loops instead of fanning out further requests.
    const bodyCodeIsRateLimit =
      typeof dataObj?.code === "string" && /\bRATE_LIMIT\b/i.test(dataObj.code as string);
    const isRateLimited = res.status === 429 || (!res.ok && bodyCodeIsRateLimit);

    if (isRateLimited) {
      clearTimeout(timeoutId);
      const maxWait = opts.rateLimitMaxRetryWaitMs ?? 30_000;
      const maxRetries = opts.rateLimitMaxRetries ?? 1;
      const retryAfter =
        parseRetryAfterMs(res.headers.get("Retry-After"), maxWait) ??
        Math.min(maxWait, 1000 * Math.pow(2, rateLimitAttempt));
      const bodyMessage =
        typeof dataObj?.message === "string"
          ? (dataObj.message as string)
          : typeof dataObj?.error === "string"
            ? (dataObj.error as string)
            : `HTTP ${res.status}`;
      if (rateLimitAttempt < maxRetries) {
        await sleep(retryAfter);
        return doRequest(opts, isRetry, rateLimitAttempt + 1);
      }
      throw new OrchestratorRateLimitError(
        `RATE_LIMIT_EXCEEDED: ${bodyMessage}`,
        retryAfter,
        res.status,
      );
    }

    if (!res.ok) {
      // Prefer `message` then `error` from JSON body; fall back to raw HTTP string.
      const errBody = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
      const errCode = typeof errBody?.code === "string" ? errBody.code : null;
      const errText =
        typeof errBody?.message === "string" ? errBody.message
        : typeof errBody?.error === "string" ? errBody.error
        : `HTTP ${res.status}: ${text.slice(0, 200)}`;
      const errMsg = errCode ? `${errCode}: ${errText}` : errText;
      throw new Error(errMsg);
    }

    return data;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Orchestrator request timed out after ${opts.timeout ?? 30000}ms: ${opts.method} ${opts.path}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
