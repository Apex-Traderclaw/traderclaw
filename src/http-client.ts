export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

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
  const result = await doRequest(opts);
  return result;
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

    if ((opts.method === "POST" || opts.method === "PUT") && opts.body) {
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

    if ((res.status === 401 || res.status === 403) && !isRetry && opts.onUnauthorized) {
      clearTimeout(timeoutId);
      const newToken = await opts.onUnauthorized();
      return doRequest({ ...opts, accessToken: newToken }, true);
    }

    if (!res.ok) {
      const errMsg =
        data && typeof data === "object" && "error" in data
          ? (data as { error: string }).error
          : `HTTP ${res.status}: ${text.slice(0, 200)}`;
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
