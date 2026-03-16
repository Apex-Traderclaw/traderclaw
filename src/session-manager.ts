export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
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

export interface SessionManagerConfig {
  baseUrl: string;
  apiKey: string;
  refreshToken?: string;
  walletPublicKey?: string;
  walletPrivateKey?: string;
  clientLabel?: string;
  timeout?: number;
  onTokensRotated?: (tokens: { refreshToken: string; walletPublicKey?: string }) => void;
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
      pkcs8Der,
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
  private walletPrivateKey: string | null = null;
  private clientLabel: string;
  private timeout: number;
  private accessTokenExpiresAt: number = 0;
  private sessionId: string | null = null;
  private tier: string | null = null;
  private scopes: string[] = [];
  private onTokensRotated?: (tokens: { refreshToken: string; walletPublicKey?: string }) => void;
  private log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  private refreshInFlight: Promise<void> | null = null;

  constructor(config: SessionManagerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.refreshTokenValue = config.refreshToken || null;
    this.walletPublicKey = config.walletPublicKey || null;
    this.walletPrivateKey = config.walletPrivateKey || null;
    this.clientLabel = config.clientLabel || "openclaw-plugin-runtime";
    this.timeout = config.timeout || 15000;
    this.onTokensRotated = config.onTokensRotated;
    this.log = config.logger || { info: console.log, warn: console.warn, error: console.error };
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

  async refresh(): Promise<SessionTokens> {
    if (!this.refreshTokenValue) {
      throw new Error("No refresh token available. Must authenticate via challenge flow.");
    }

    const res = await rawFetch(
      `${this.baseUrl}/api/session/refresh`,
      "POST",
      { refreshToken: this.refreshTokenValue },
      undefined,
      this.timeout,
    );

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        this.accessToken = null;
        this.refreshTokenValue = null;
        this.accessTokenExpiresAt = 0;
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
      throw new Error("No apiKey configured. Run signup or provide an apiKey.");
    }

    this.log.info("[session] Starting challenge flow...");
    const challenge = await this.requestChallenge();

    let walletPubKey: string | undefined;
    let walletSig: string | undefined;

    if (challenge.walletProofRequired && challenge.challenge) {
      if (!this.walletPrivateKey) {
        throw new Error(
          "Wallet proof required but no walletPrivateKey configured. " +
          "This account already has a wallet — you must provide the wallet private key to prove ownership. " +
          "Set walletPrivateKey in plugin config or run: openclaw-trader config set walletPrivateKey <base58_key>"
        );
      }

      walletPubKey = challenge.walletPublicKey || this.walletPublicKey || undefined;
      this.log.info("[session] Signing wallet challenge locally...");
      walletSig = await signChallengeAsync(challenge.challenge, this.walletPrivateKey);
    }

    const tokens = await this.startSession(challenge.challengeId, walletPubKey, walletSig);
    this.log.info(`[session] Session established. ID: ${this.sessionId}, Tier: ${this.tier}`);

    if (challenge.walletPublicKey) {
      this.walletPublicKey = challenge.walletPublicKey;
    }
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 30000) {
      return this.accessToken;
    }

    if (!this.refreshInFlight) {
      this.refreshInFlight = this.ensureRefreshed();
    }

    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }

    if (!this.accessToken) {
      throw new Error("Failed to obtain access token after refresh.");
    }

    return this.accessToken;
  }

  async handleUnauthorized(): Promise<string> {
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;

    if (!this.refreshInFlight) {
      this.refreshInFlight = this.ensureRefreshed();
    }

    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }

    if (!this.accessToken) {
      throw new Error("Session expired and could not be refreshed. Re-authentication required.");
    }

    return this.accessToken;
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
    this.accessToken = tokens.accessToken;
    this.refreshTokenValue = tokens.refreshToken;
    this.accessTokenExpiresAt = Date.now() + tokens.accessTokenTtlSeconds * 1000;
    this.sessionId = tokens.session.id;
    this.tier = tokens.session.tier;
    this.scopes = tokens.session.scopes;

    if (this.onTokensRotated) {
      this.onTokensRotated({
        refreshToken: tokens.refreshToken,
        walletPublicKey: this.walletPublicKey || undefined,
      });
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
