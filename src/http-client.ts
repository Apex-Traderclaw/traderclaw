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
      return doRequest({ ...opts, accessToken: newToken }, true);
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
