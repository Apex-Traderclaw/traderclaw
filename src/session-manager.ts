export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Present when the server returns a one-time recovery secret alongside the session (e.g. after wallet-proof challenge for existing accounts). */
  recoverySecret?: string;
  session: {
    id: string;
    apiKey: string;
    tier: string;
    scopes: string[];
    expiresAt: string;
  };
}

export interface SignupResult {
  ok: boolean;
  externalUserId: string;
  tier: string;
  scopes: string[];
  apiKey: string;
  createdAt: string;
}

export interface ChallengeResult {
  ok: boolean;
  walletProofRequired: boolean;
  challengeId: string;
  challenge?: string;
  walletPublicKey?: string;
  expiresAt?: string;
  signatureEncoding?: string;
}

const TRADERCLAW_SESSION_TROUBLESHOOTING =
  "https://docs.traderclaw.ai/docs/installation#troubleshooting-session-expired-auth-errors-or-the-agent-logged-out";

/** Emitted whenever access/refresh tokens change (refresh, startSession, etc.). */
export interface RotatedSessionTokens {
  refreshToken: string;
  accessToken: string;
  /** Unix epoch milliseconds when the access token expires. */
  accessTokenExpiresAt: number;
  walletPublicKey?: string;
}

export interface SessionManagerConfig {
  baseUrl: string;
  apiKey: string;
  refreshToken?: string;
  walletPublicKey?: string;
  walletPrivateKeyProvider?: () => string | undefined | Promise<string | undefined>;
  /** Called before consumable recovery; re-read from disk each time for hot reload. */
  recoverySecretProvider?: () => string | undefined | Promise<string | undefined>;
  /** After successful /api/session/recover-secret, persist rotated secret (e.g. openclaw.json). */
  onRecoverySecretRotated?: (newSecret: string) => void;
  clientLabel?: string;
  timeout?: number;
  /** If still valid, avoids an immediate /api/session/refresh on cold start. */
  initialAccessToken?: string;
  initialAccessTokenExpiresAt?: number;
  onTokensRotated?: (tokens: RotatedSessionTokens) => void;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

const BS58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58Decode(str: string): Uint8Array {
  let num = BigInt(0);
  for (const c of str) {
    const idx = BS58_CHARS.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base58 character: ${c}`);
    num = num * 58n + BigInt(idx);
  }
  const hex = num.toString(16);
  const paddedHex = hex.length % 2 ? "0" + hex : hex;
  const bytes = new Uint8Array(paddedHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(paddedHex.substring(i * 2, i * 2 + 2), 16);
  }
  let leadingZeros = 0;
  for (const c of str) {
    if (c === "1") leadingZeros++;
    else break;
  }
  if (leadingZeros > 0) {
    const combined = new Uint8Array(leadingZeros + bytes.length);
    combined.set(bytes, leadingZeros);
    return combined;
  }
  return bytes;
}

function b58Encode(bytes: Uint8Array): string {
  let num = BigInt(0);
  for (const b of bytes) {
    num = num * 256n + BigInt(b);
  }
  let result = "";
  while (num > 0n) {
    result = BS58_CHARS[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const b of bytes) {
    if (b === 0) result = "1" + result;
    else break;
  }
  return result || "1";
}

function buildEd25519Pkcs8(rawPrivKey: Uint8Array): Uint8Array {
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const result = new Uint8Array(prefix.length + 32);
  result.set(prefix);
  result.set(rawPrivKey.slice(0, 32), prefix.length);
  return result;
}

async function signChallengeAsync(challengeBytes: string, privateKeyBase58: string): Promise<string> {
  const keyBytes = b58Decode(privateKeyBase58);
  const privKeyRaw = keyBytes.slice(0, 32);
  const pkcs8Der = buildEd25519Pkcs8(privKeyRaw);

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8Der as BufferSource,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const sigBytes = new Uint8Array(
      await crypto.subtle.sign("Ed25519", cryptoKey, new TextEncoder().encode(challengeBytes)),
    );
    return b58Encode(sigBytes);
  } catch {
    try {
      const nodeCrypto = await import("crypto");
      const keyObj = nodeCrypto.createPrivateKey({
        key: Buffer.from(pkcs8Der),
        format: "der",
        type: "pkcs8",
      });
      const sig = nodeCrypto.sign(null, Buffer.from(challengeBytes, "utf-8"), keyObj);
      return b58Encode(new Uint8Array(sig));
    } catch (innerErr: any) {
      throw new Error(`Failed to sign challenge: ${innerErr.message}. Ensure walletPrivateKey is a valid base58-encoded Solana private key.`);
    }
  }
}

async function rawFetch(
  url: string,
  method: string,
  body?: Record<string, unknown>,
  bearerToken?: string,
  timeout = 15000,
): Promise<{ ok: boolean; status: number; data: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    }

    const fetchOpts: RequestInit = { method, headers, signal: controller.signal };
    if (body) {
      fetchOpts.body = JSON.stringify(body);
    }

    const res = await fetch(url, fetchOpts);
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Session request timed out after ${timeout}ms: ${method} ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export class SessionManager {
  private baseUrl: string;
  private apiKey: string;
  private accessToken: string | null = null;
  private refreshTokenValue: string | null = null;
  private walletPublicKey: string | null = null;
  private walletPrivateKeyProvider?: () => string | undefined | Promise<string | undefined>;
  private recoverySecretProvider?: () => string | undefined | Promise<string | undefined>;
  private onRecoverySecretRotated?: (newSecret: string) => void;
  private clientLabel: string;
  private timeout: number;
  private accessTokenExpiresAt: number = 0;
  private sessionId: string | null = null;
  private tier: string | null = null;
  private scopes: string[] = [];
  private onTokensRotated?: (tokens: RotatedSessionTokens) => void;
  private log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  private refreshInFlight: Promise<void> | null = null;
  private refreshTokenTtlMs: number = 0;
  private accessTokenTtlMs: number = 0;
  private tokenGeneration = 0;
  private proactiveRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private proactiveRefreshRunning = false;

  constructor(config: SessionManagerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.refreshTokenValue = config.refreshToken || null;
    this.walletPublicKey = config.walletPublicKey || null;
    this.walletPrivateKeyProvider = config.walletPrivateKeyProvider;
    this.recoverySecretProvider = config.recoverySecretProvider;
    this.onRecoverySecretRotated = config.onRecoverySecretRotated;
    this.clientLabel = config.clientLabel || "openclaw-plugin-runtime";
    this.timeout = config.timeout || 15000;
    this.onTokensRotated = config.onTokensRotated;
    this.log = config.logger || { info: console.log, warn: console.warn, error: console.error };

    const initTok = config.initialAccessToken;
    const initExp = config.initialAccessTokenExpiresAt;
    const skewMs = 5000;
    if (initTok && initExp != null && Date.now() < initExp - skewMs) {
      this.accessToken = initTok;
      this.accessTokenExpiresAt = initExp;
    }
  }

  async signup(externalUserId: string): Promise<SignupResult> {
    const res = await rawFetch(
      `${this.baseUrl}/api/auth/signup`,
      "POST",
      { externalUserId },
      undefined,
      this.timeout,
    );

    if (!res.ok) {
      throw new Error(`Signup failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    }

    this.apiKey = res.data.apiKey;
    return res.data as SignupResult;
  }

  async requestChallenge(): Promise<ChallengeResult> {
    const body: Record<string, unknown> = {
      apiKey: this.apiKey,
      clientLabel: this.clientLabel,
    };
    if (this.walletPublicKey) {
      body.walletPublicKey = this.walletPublicKey;
    }

    const res = await rawFetch(
      `${this.baseUrl}/api/session/challenge`,
      "POST",
      body,
      undefined,
      this.timeout,
    );

    if (!res.ok) {
      throw new Error(`Challenge request failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    }

    return res.data as ChallengeResult;
  }

  async startSession(
    challengeId: string,
    walletPublicKey?: string,
    walletSignature?: string,
  ): Promise<SessionTokens> {
    const body: Record<string, unknown> = {
      apiKey: this.apiKey,
      challengeId,
      clientLabel: this.clientLabel,
    };
    if (walletPublicKey) body.walletPublicKey = walletPublicKey;
    if (walletSignature) body.walletSignature = walletSignature;

    const res = await rawFetch(
      `${this.baseUrl}/api/session/start`,
      "POST",
      body,
      undefined,
      this.timeout,
    );

    if (!res.ok) {
      throw new Error(`Session start failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    }

    const tokens = res.data as SessionTokens;
    this.applyTokens(tokens);
    return tokens;
  }

  /**
   * One-time consumable secret recovery (orchestrator rotates secret on success).
   * Response may include `recoverySecret` for the next failure path.
   */
  async recoverSessionWithConsumableSecret(recoverySecret: string): Promise<SessionTokens & { recoverySecret?: string }> {
    const trimmed = recoverySecret.trim();
    if (!trimmed) {
      throw new Error("Recovery secret is empty.");
    }

    const res = await rawFetch(
      `${this.baseUrl}/api/session/recover-secret`,
      "POST",
      {
        apiKey: this.apiKey,
        recoverySecret: trimmed,
        clientLabel: this.clientLabel,
      },
      undefined,
      this.timeout,
    );

    if (!res.ok) {
      throw new Error(`Session recover-secret failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    }

    const data = res.data as SessionTokens & { recoverySecret?: string };
    this.applyTokens(data);
    if (data.recoverySecret && this.onRecoverySecretRotated) {
      try {
        this.onRecoverySecretRotated(data.recoverySecret);
      } catch (err: unknown) {
        this.log.warn(
          `[session] Failed to persist rotated recovery secret: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return data;
  }

  async refresh(): Promise<SessionTokens> {
    if (!this.refreshTokenValue) {
      throw new Error("No refresh token available. Must authenticate via challenge flow.");
    }

    const genBefore = this.tokenGeneration;

    const res = await rawFetch(
      `${this.baseUrl}/api/session/refresh`,
      "POST",
      { refreshToken: this.refreshTokenValue },
      undefined,
      this.timeout,
    );

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        if (this.tokenGeneration === genBefore) {
          this.accessToken = null;
          this.refreshTokenValue = null;
          this.accessTokenExpiresAt = 0;
        } else {
          this.log.info("[session] Stale 401/403 ignored — tokens already rotated by concurrent call.");
        }
        throw new Error("Refresh token expired or revoked. Must re-authenticate via challenge flow.");
      }
      throw new Error(`Token refresh failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    }

    const tokens = res.data as SessionTokens;
    this.applyTokens(tokens);
    return tokens;
  }

  async logout(): Promise<void> {
    if (!this.refreshTokenValue) return;

    try {
      await rawFetch(
        `${this.baseUrl}/api/session/logout`,
        "POST",
        { refreshToken: this.refreshTokenValue },
        undefined,
        this.timeout,
      );
    } finally {
      this.destroy();
      this.accessToken = null;
      this.refreshTokenValue = null;
      this.accessTokenExpiresAt = 0;
      this.sessionId = null;
    }
  }

  async initialize(): Promise<void> {
    if (this.refreshTokenValue) {
      try {
        this.log.info("[session] Refreshing existing session...");
        await this.refresh();
        this.log.info(`[session] Session refreshed. Tier: ${this.tier}, Scopes: ${this.scopes.join(", ")}`);
        return;
      } catch (err: any) {
        this.log.warn(`[session] Refresh failed: ${err.message}. Falling back to challenge flow.`);
      }
    }

    if (!this.apiKey) {
      throw new Error(
        "No apiKey configured. On this machine run: traderclaw setup --signup (or traderclaw signup) for a new account, " +
          "or add an API key via traderclaw setup. The agent cannot create accounts or change credentials.",
      );
    }

    const recoverySecret = (await this.recoverySecretProvider?.())?.trim();
    if (recoverySecret) {
      try {
        this.log.info("[session] Attempting consumable recovery secret...");
        await this.recoverSessionWithConsumableSecret(recoverySecret);
        this.log.info(`[session] Session recovered via consumable secret. Tier: ${this.tier}`);
        return;
      } catch (err: unknown) {
        this.log.warn(
          `[session] Consumable recovery failed: ${err instanceof Error ? err.message : String(err)}. Falling back to challenge flow...`,
        );
      }
    }

    this.log.info("[session] Starting challenge flow...");
    const challenge = await this.requestChallenge();

    let walletPubKey: string | undefined;
    let walletSig: string | undefined;

    if (challenge.walletProofRequired && challenge.challenge) {
      const walletPrivateKey = (await this.walletPrivateKeyProvider?.())?.trim();
      if (!walletPrivateKey) {
        throw new Error(
          "Wallet proof required but the gateway cannot sign interactively — no wallet key is wired into this process. " +
            "This account already has a wallet. On the host that runs OpenClaw (with a normal terminal / TTY), run: traderclaw login — complete wallet proof when prompted — then openclaw gateway restart. " +
            "That persists new session tokens without putting a private key in the gateway configuration. Do not paste private keys into openclaw.json. " +
            `Troubleshooting: ${TRADERCLAW_SESSION_TROUBLESHOOTING}`,
        );
      }

      walletPubKey = challenge.walletPublicKey || this.walletPublicKey || undefined;
      this.log.info("[session] Signing wallet challenge locally...");
      walletSig = await signChallengeAsync(challenge.challenge, walletPrivateKey);
    }

    const tokens = await this.startSession(challenge.challengeId, walletPubKey, walletSig);
    this.log.info(`[session] Session established. ID: ${this.sessionId}, Tier: ${this.tier}`);

    if (challenge.walletPublicKey) {
      this.walletPublicKey = challenge.walletPublicKey;
    }

    // If the server included a recovery secret in the session-start response (e.g. for
    // existing accounts that completed a wallet-proof challenge), persist it so the gateway
    // can re-authenticate via recover-secret when the refresh token later expires —
    // avoiding the need for TRADERCLAW_WALLET_PRIVATE_KEY on every re-auth cycle.
    if (tokens.recoverySecret && this.onRecoverySecretRotated) {
      try {
        this.onRecoverySecretRotated(tokens.recoverySecret);
        this.log.info("[session] Recovery secret from session start persisted.");
      } catch (err: unknown) {
        this.log.warn(
          `[session] Failed to persist recovery secret from session start: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 120000) {
      return this.accessToken;
    }

    await this.unifiedRefresh();

    if (!this.accessToken) {
      throw new Error(
        `Session expired and could not be refreshed. Re-authentication required. On the gateway host try: traderclaw login — then openclaw gateway restart. Troubleshooting: ${TRADERCLAW_SESSION_TROUBLESHOOTING}`,
      );
    }

    return this.accessToken;
  }

  async handleUnauthorized(): Promise<string> {
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;

    await this.unifiedRefresh();

    if (!this.accessToken) {
      throw new Error(
        `Session expired and could not be refreshed. Re-authentication required. On the gateway host try: traderclaw login — then openclaw gateway restart. Troubleshooting: ${TRADERCLAW_SESSION_TROUBLESHOOTING}`,
      );
    }

    return this.accessToken;
  }

  /**
   * Single-mutex refresh: all paths (proactive timer, on-demand getAccessToken,
   * handleUnauthorized) funnel through here so only one refresh HTTP call is
   * ever in-flight. Prevents the race where two concurrent refresh() calls
   * with the same rotating refresh token kill the session.
   */
  private async unifiedRefresh(): Promise<void> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.ensureRefreshed().finally(() => {
        this.refreshInFlight = null;
      });
    }
    await this.refreshInFlight;
  }

  isAuthenticated(): boolean {
    return !!this.accessToken;
  }

  getSessionInfo(): { sessionId: string | null; tier: string | null; scopes: string[]; apiKey: string } {
    return {
      sessionId: this.sessionId,
      tier: this.tier,
      scopes: this.scopes,
      apiKey: this.apiKey,
    };
  }

  getApiKey(): string {
    return this.apiKey;
  }

  getRefreshToken(): string | null {
    return this.refreshTokenValue;
  }

  getWalletPublicKey(): string | null {
    return this.walletPublicKey;
  }

  private applyTokens(tokens: SessionTokens): void {
    this.tokenGeneration++;
    this.accessToken = tokens.accessToken;
    this.refreshTokenValue = tokens.refreshToken;
    this.accessTokenExpiresAt = Date.now() + tokens.accessTokenTtlSeconds * 1000;
    this.accessTokenTtlMs = tokens.accessTokenTtlSeconds * 1000;
    this.refreshTokenTtlMs = (tokens.refreshTokenTtlSeconds || 0) * 1000;
    this.sessionId = tokens.session.id;
    this.tier = tokens.session.tier;
    this.scopes = tokens.session.scopes;

    if (this.onTokensRotated) {
      this.onTokensRotated({
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: this.accessTokenExpiresAt,
        walletPublicKey: this.walletPublicKey || undefined,
      });
    }

    this.scheduleProactiveRefresh();
  }

  /**
   * Schedule a repeating background token refresh. Uses setInterval so the
   * chain cannot silently break if a single cycle fails to re-schedule.
   *
   * Interval = min(50% refresh-token TTL, accessTokenTtl - 2.5 min buffer),
   * clamped between 2 min and 20 min. Falls back to 10 min when TTLs unknown.
   *
   * Goes through unifiedRefresh() so it shares the same mutex as on-demand
   * callers and can fall back to the full challenge flow when refresh tokens
   * are permanently revoked.
   */
  private scheduleProactiveRefresh(): void {
    if (this.proactiveRefreshTimer) {
      clearInterval(this.proactiveRefreshTimer);
      this.proactiveRefreshTimer = null;
    }

    const MIN_INTERVAL_MS = 2 * 60 * 1000;
    const MAX_INTERVAL_MS = 20 * 60 * 1000;
    const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

    let intervalMs: number;
    if (this.refreshTokenTtlMs > 0) {
      intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(this.refreshTokenTtlMs * 0.5, MAX_INTERVAL_MS));
    } else {
      intervalMs = DEFAULT_INTERVAL_MS;
    }

    if (this.accessTokenTtlMs > 0) {
      const accessBasedMs = Math.max(MIN_INTERVAL_MS, this.accessTokenTtlMs - 150_000);
      intervalMs = Math.min(intervalMs, accessBasedMs);
    }

    this.log.info(`[session] Proactive refresh scheduled every ${Math.round(intervalMs / 1000)}s`);

    this.proactiveRefreshTimer = setInterval(async () => {
      if (this.proactiveRefreshRunning) return;
      this.proactiveRefreshRunning = true;
      try {
        this.log.info(`[session] Proactive token refresh (interval: ${Math.round(intervalMs / 1000)}s)...`);
        await this.unifiedRefresh();
        this.log.info("[session] Proactive refresh succeeded — token chain extended.");
      } catch (err: any) {
        this.log.warn(`[session] Proactive refresh failed: ${err.message}. Will retry next interval or on-demand.`);
      } finally {
        this.proactiveRefreshRunning = false;
      }
    }, intervalMs);

    if (this.proactiveRefreshTimer && typeof this.proactiveRefreshTimer === "object" && "unref" in this.proactiveRefreshTimer) {
      (this.proactiveRefreshTimer as NodeJS.Timeout).unref();
    }
  }

  destroy(): void {
    if (this.proactiveRefreshTimer) {
      clearInterval(this.proactiveRefreshTimer);
      this.proactiveRefreshTimer = null;
    }
  }

  private async ensureRefreshed(): Promise<void> {
    if (this.refreshTokenValue) {
      try {
        await this.refresh();
        return;
      } catch {
        this.log.warn("[session] Refresh failed during token renewal. Attempting challenge flow...");
      }
    }

    await this.initialize();
  }
}
