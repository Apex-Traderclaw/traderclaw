export interface ToolEnvelope<T = unknown> {
  ok: boolean;
  data: T | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  generatedAt: string;
  source: string;
  traceId: string;
}

const ERROR_CLASSIFICATION: Record<string, { retryable: boolean; code: string }> = {
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
  "503": { retryable: true, code: "SERVER_ERROR" },
  // Referral-specific codes (sent as "CODE: message" by http-client after extraction)
  "REFERRAL_CODE_TAKEN": { retryable: false, code: "REFERRAL_CODE_TAKEN" },
  "referral code already taken": { retryable: false, code: "REFERRAL_CODE_TAKEN" },
  "REFERRAL_CODE_INVALID": { retryable: false, code: "REFERRAL_CODE_INVALID" },
  "REFERRAL_CODE_ERROR": { retryable: false, code: "REFERRAL_CODE_ERROR" },
  "alphanumeric": { retryable: false, code: "VALIDATION_ERROR" },
};

function generateTraceId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `tc-${ts}-${rand}`;
}

function classifyError(err: unknown): { code: string; retryable: boolean; message: string } {
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

export function normalizeToolSuccess<T>(data: T, source: string): ToolEnvelope<T> {
  return {
    ok: true,
    data,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    generatedAt: new Date().toISOString(),
    source,
    traceId: generateTraceId(),
  };
}

export function normalizeToolError(err: unknown, source: string): ToolEnvelope<null> {
  const classified = classifyError(err);
  return {
    ok: false,
    data: null,
    errorCode: classified.code,
    errorMessage: classified.message,
    retryable: classified.retryable,
    generatedAt: new Date().toISOString(),
    source,
    traceId: generateTraceId(),
  };
}

export function renderToolEnvelope<T>(envelope: ToolEnvelope<T>): string {
  if (envelope.ok) {
    return JSON.stringify({
      ok: true,
      data: envelope.data,
      source: envelope.source,
      generatedAt: envelope.generatedAt,
      traceId: envelope.traceId,
    });
  }

  return JSON.stringify({
    ok: false,
    errorCode: envelope.errorCode,
    errorMessage: envelope.errorMessage,
    retryable: envelope.retryable,
    source: envelope.source,
    generatedAt: envelope.generatedAt,
    traceId: envelope.traceId,
  });
}

export async function envelopedExecute<T>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<string> {
  try {
    const result = await fn();
    return renderToolEnvelope(normalizeToolSuccess(result, toolName));
  } catch (err) {
    return renderToolEnvelope(normalizeToolError(err, toolName));
  }
}
