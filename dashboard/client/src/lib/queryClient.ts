import { QueryClient } from "@tanstack/react-query";
import type { QueryFunction } from "@tanstack/react-query";
import bs58 from "bs58";
import nacl from "tweetnacl";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

const SESSION_STORAGE_KEY = "openclaw.user.session";
const API_KEY_STORAGE_KEY = "openclaw.user.apiKey";
const EXTERNAL_USER_ID_STORAGE_KEY = "openclaw.user.externalUserId";

type UserSessionState = {
  apiKey: string;
  accessToken: string;
  refreshToken: string;
  isAdmin?: boolean;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
};

type SessionChallengeResponse = {
  ok: boolean;
  walletProofRequired?: boolean;
  challengeId?: string;
  challenge?: string;
  walletPublicKey?: string;
  expiresAt?: string;
};

const loadSessionState = (): UserSessionState | null => {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as UserSessionState;
  } catch {
    return null;
  }
};

const saveSessionState = (state: UserSessionState | null) => {
  if (!state) {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state));
};

const loadStoredApiKey = (): string | null => {
  try {
    const value = localStorage.getItem(API_KEY_STORAGE_KEY);
    return value?.trim() || null;
  } catch {
    return null;
  }
};

const saveStoredApiKey = (apiKey: string | null) => {
  try {
    if (!apiKey) {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
      return;
    }
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
  } catch {
    // ignore storage errors; caller handles runtime fallback
  }
};

const randomId = (length = 16) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const getOrCreateExternalUserId = () => {
  try {
    const existing = localStorage.getItem(EXTERNAL_USER_ID_STORAGE_KEY)?.trim();
    if (existing) return existing;
    const created = `oc_dash_${randomId(12)}`;
    localStorage.setItem(EXTERNAL_USER_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return `oc_dash_${randomId(12)}`;
  }
};

type SignupResponse = {
  apiKey?: string;
};

export async function provisionDashboardApiKey(): Promise<string> {
  const existingApiKey = loadStoredApiKey();
  if (existingApiKey) return existingApiKey;

  const trySignup = async (externalUserId: string): Promise<string | null> => {
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ externalUserId }),
    });
    if (res.status === 201) {
      const payload = (await res.json()) as SignupResponse;
      if (payload?.apiKey) {
        saveStoredApiKey(payload.apiKey);
        return payload.apiKey;
      }
    }
    return null;
  };

  const firstExternalUserId = getOrCreateExternalUserId();
  const firstResult = await trySignup(firstExternalUserId);
  if (firstResult) return firstResult;

  // If local external user id collided/was previously used without local api key,
  // generate a new one and retry once.
  const retryExternalUserId = `oc_dash_${randomId(12)}`;
  try {
    localStorage.setItem(EXTERNAL_USER_ID_STORAGE_KEY, retryExternalUserId);
  } catch {
    // ignore storage errors
  }
  const retryResult = await trySignup(retryExternalUserId);
  if (retryResult) return retryResult;

  throw new Error("Failed to auto-provision API key");
}

export const getStoredApiKey = () => loadStoredApiKey();
export const clearStoredApiKey = () => saveStoredApiKey(null);

export const getSessionState = () => loadSessionState();
export const getAccessToken = () => loadSessionState()?.accessToken || "";

let refreshInFlight: Promise<string | null> | null = null;

const unauthorizedError = () => new Error("401: Unauthorized");

const textEncoder = new TextEncoder();

const decodePrivateKey = (privateKeyInput: string): Uint8Array => {
  const raw = String(privateKeyInput || "").trim();
  if (!raw) {
    throw new Error("Wallet private key is required");
  }

  if (raw.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Wallet private key JSON format is invalid");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Wallet private key JSON array is empty");
    }
    return Uint8Array.from(parsed as number[]);
  }

  try {
    return bs58.decode(raw);
  } catch {
    throw new Error("Wallet private key must be valid base58 or JSON array");
  }
};

const deriveKeypair = (privateKeyInput: string) => {
  const keyBytes = decodePrivateKey(privateKeyInput);
  if (keyBytes.length === 64) {
    return nacl.sign.keyPair.fromSecretKey(keyBytes);
  }
  if (keyBytes.length === 32) {
    return nacl.sign.keyPair.fromSeed(keyBytes);
  }
  throw new Error("Wallet private key must decode to 32 or 64 bytes");
};

const createSessionSignatureProof = (privateKeyInput: string, challenge: string) => {
  const keypair = deriveKeypair(privateKeyInput);
  const messageBytes = textEncoder.encode(String(challenge || ""));
  const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
  return {
    walletPublicKey: bs58.encode(keypair.publicKey),
    walletSignature: bs58.encode(signatureBytes),
  };
};

const authorizedFetch = async (
  url: string,
  init: RequestInit = {},
  opts: { allowRefreshRetry?: boolean } = {},
): Promise<Response> => {
  const state = loadSessionState();
  const headers = new Headers(init.headers || {});
  if (state?.accessToken) {
    headers.set("Authorization", `Bearer ${state.accessToken}`);
  }

  const res = await fetch(url, {
    ...init,
    headers,
    credentials: "include",
  });

  if (res.status !== 401 || opts.allowRefreshRetry === false) {
    return res;
  }

  const nextAccessToken = await refreshUserSession();
  if (!nextAccessToken) {
    return res;
  }

  const retryHeaders = new Headers(init.headers || {});
  retryHeaders.set("Authorization", `Bearer ${nextAccessToken}`);
  return fetch(url, {
    ...init,
    headers: retryHeaders,
    credentials: "include",
  });
};

const parseSessionResponse = async (res: Response) => {
  await throwIfResNotOk(res);
  const payload = await res.json();
  const resolvedApiKey = payload?.session?.apiKey || "";
  const state: UserSessionState = {
    apiKey: resolvedApiKey,
    accessToken: payload?.accessToken || "",
    refreshToken: payload?.refreshToken || "",
    isAdmin: Boolean(payload?.session?.isAdmin),
    accessTokenTtlSeconds: payload?.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: payload?.refreshTokenTtlSeconds,
  };
  saveSessionState(state);
  if (resolvedApiKey) {
    saveStoredApiKey(resolvedApiKey);
  }
  return payload;
};

export async function startUserSession(params: { apiKey: string; walletPrivateKey?: string; clientLabel?: string }) {
  const challengeRes = await fetch("/api/session/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      apiKey: params.apiKey,
      clientLabel: params.clientLabel,
    }),
  });
  await throwIfResNotOk(challengeRes);
  const challengePayload = (await challengeRes.json()) as SessionChallengeResponse;

  const sessionStartPayload: Record<string, unknown> = {
    apiKey: params.apiKey,
    clientLabel: params.clientLabel,
  };

  if (challengePayload.walletProofRequired) {
    if (!challengePayload.challengeId || !challengePayload.challenge) {
      throw new Error("Session challenge payload missing challenge data");
    }
    if (!params.walletPrivateKey) {
      throw new Error("Wallet private key is required for this account");
    }

    const proof = createSessionSignatureProof(params.walletPrivateKey, challengePayload.challenge);
    sessionStartPayload.challengeId = challengePayload.challengeId;
    sessionStartPayload.walletPublicKey = proof.walletPublicKey;
    sessionStartPayload.walletSignature = proof.walletSignature;
  }

  const res = await fetch("/api/session/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(sessionStartPayload),
  });
  return parseSessionResponse(res);
}

export async function refreshUserSession(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const state = loadSessionState();
    if (!state?.refreshToken) {
      saveSessionState(null);
      return null;
    }
    const res = await fetch("/api/session/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ refreshToken: state.refreshToken }),
    }).catch(() => null);
    if (!res) {
      return null;
    }
    if (!res.ok) {
      saveSessionState(null);
      return null;
    }
    const payload = await res.json();
    const nextState: UserSessionState = {
      apiKey: payload?.session?.apiKey || state.apiKey,
      accessToken: payload?.accessToken || "",
      refreshToken: payload?.refreshToken || state.refreshToken,
      isAdmin: Boolean(payload?.session?.isAdmin),
      accessTokenTtlSeconds: payload?.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: payload?.refreshTokenTtlSeconds,
    };
    saveSessionState(nextState);
    return nextState.accessToken || null;
  })();

  const result = await refreshInFlight;
  refreshInFlight = null;
  return result;
}

export async function logoutUserSession() {
  const state = loadSessionState();
  if (state?.refreshToken) {
    await fetch("/api/session/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ refreshToken: state.refreshToken }),
    }).catch(() => null);
  }
  saveSessionState(null);
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const bodyRaw = data ? JSON.stringify(data) : "";
  const res = await authorizedFetch(url, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? bodyRaw : undefined,
  });
  if (res.status === 401) {
    throw unauthorizedError();
  }
  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const [base = "", ...parts] = queryKey.map((part) => String(part || ""));
    let url = base;
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith("?") || part.startsWith("&")) {
        url += part;
      } else {
        const needsSlash = !url.endsWith("/") && !part.startsWith("/");
        url += needsSlash ? `/${part}` : part;
      }
    }

    const res = await authorizedFetch(url, {});
    if (res.status === 401) {
      if (unauthorizedBehavior === "returnNull") return null;
      throw unauthorizedError();
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "returnNull" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

// Backward-compatible helper for old components.
export async function requireAuthSession() {
  const state = loadSessionState();
  if (state?.accessToken) return state;
  const refreshed = await refreshUserSession();
  if (!refreshed) throw unauthorizedError();
  const next = loadSessionState();
  if (!next?.accessToken) throw unauthorizedError();
  return next;
}

export function isAdminSession() {
  return Boolean(loadSessionState()?.isAdmin);
}
