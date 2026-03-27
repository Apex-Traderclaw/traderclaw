// src/session-manager.ts
var TRADERCLAW_SESSION_TROUBLESHOOTING = "https://docs.traderclaw.ai/docs/installation#troubleshooting-session-expired-auth-errors-or-the-agent-logged-out";
var BS58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58Decode(str) {
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
function b58Encode(bytes) {
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
function buildEd25519Pkcs8(rawPrivKey) {
  const prefix = new Uint8Array([
    48,
    46,
    2,
    1,
    0,
    48,
    5,
    6,
    3,
    43,
    101,
    112,
    4,
    34,
    4,
    32
  ]);
  const result = new Uint8Array(prefix.length + 32);
  result.set(prefix);
  result.set(rawPrivKey.slice(0, 32), prefix.length);
  return result;
}
async function signChallengeAsync(challengeBytes, privateKeyBase58) {
  const keyBytes = b58Decode(privateKeyBase58);
  const privKeyRaw = keyBytes.slice(0, 32);
  const pkcs8Der = buildEd25519Pkcs8(privKeyRaw);
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8Der,
      { name: "Ed25519" },
      false,
      ["sign"]
    );
    const sigBytes = new Uint8Array(
      await crypto.subtle.sign("Ed25519", cryptoKey, new TextEncoder().encode(challengeBytes))
    );
    return b58Encode(sigBytes);
  } catch {
    try {
      const nodeCrypto = await import("crypto");
      const keyObj = nodeCrypto.createPrivateKey({
        key: Buffer.from(pkcs8Der),
        format: "der",
        type: "pkcs8"
      });
      const sig = nodeCrypto.sign(null, Buffer.from(challengeBytes, "utf-8"), keyObj);
      return b58Encode(new Uint8Array(sig));
    } catch (innerErr) {
      throw new Error(`Failed to sign challenge: ${innerErr.message}. Ensure walletPrivateKey is a valid base58-encoded Solana private key.`);
    }
  }
}
async function rawFetch(url, method, body, bearerToken, timeout = 15e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { "Content-Type": "application/json" };
    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    }
    const fetchOpts = { method, headers, signal: controller.signal };
    if (body) {
      fetchOpts.body = JSON.stringify(body);
    }
    const res = await fetch(url, fetchOpts);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Session request timed out after ${timeout}ms: ${method} ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
var SessionManager = class {
  baseUrl;
  apiKey;
  accessToken = null;
  refreshTokenValue = null;
  walletPublicKey = null;
  walletPrivateKeyProvider;
  clientLabel;
  timeout;
  accessTokenExpiresAt = 0;
  sessionId = null;
  tier = null;
  scopes = [];
  onTokensRotated;
  log;
  refreshInFlight = null;
  refreshTokenTtlMs = 0;
  accessTokenTtlMs = 0;
  tokenGeneration = 0;
  proactiveRefreshTimer = null;
  proactiveRefreshRunning = false;
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.refreshTokenValue = config.refreshToken || null;
    this.walletPublicKey = config.walletPublicKey || null;
    this.walletPrivateKeyProvider = config.walletPrivateKeyProvider;
    this.clientLabel = config.clientLabel || "openclaw-plugin-runtime";
    this.timeout = config.timeout || 15e3;
    this.onTokensRotated = config.onTokensRotated;
    this.log = config.logger || { info: console.log, warn: console.warn, error: console.error };
    const initTok = config.initialAccessToken;
    const initExp = config.initialAccessTokenExpiresAt;
    const skewMs = 5e3;
    if (initTok && initExp != null && Date.now() < initExp - skewMs) {
      this.accessToken = initTok;
      this.accessTokenExpiresAt = initExp;
    }
  }
  async signup(externalUserId) {
    const res = await rawFetch(
      `${this.baseUrl}/api/auth/signup`,
      "POST",
      { externalUserId },
      void 0,
      this.timeout
    );
    if (!res.ok) {
      throw new Error(`Signup failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    }
    this.apiKey = res.data.apiKey;
    return res.data;
  }
  async requestChallenge() {
    const body = {
      apiKey: this.apiKey,
      clientLabel: this.clientLabel
    };
    if (this.walletPublicKey) {
      body.walletPublicKey = this.walletPublicKey;
    }
    const res = await rawFetch(
      `${this.baseUrl}/api/session/challenge`,
      "POST",
      body,
      void 0,
      this.timeout
    );
    if (!res.ok) {
      throw new Error(`Challenge request failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    }
    return res.data;
  }
  async startSession(challengeId, walletPublicKey, walletSignature) {
    const body = {
      apiKey: this.apiKey,
      challengeId,
      clientLabel: this.clientLabel
    };
    if (walletPublicKey) body.walletPublicKey = walletPublicKey;
    if (walletSignature) body.walletSignature = walletSignature;
    const res = await rawFetch(
      `${this.baseUrl}/api/session/start`,
      "POST",
      body,
      void 0,
      this.timeout
    );
    if (!res.ok) {
      throw new Error(`Session start failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    }
    const tokens = res.data;
    this.applyTokens(tokens);
    return tokens;
  }
  async refresh() {
    if (!this.refreshTokenValue) {
      throw new Error("No refresh token available. Must authenticate via challenge flow.");
    }
    const genBefore = this.tokenGeneration;
    const res = await rawFetch(
      `${this.baseUrl}/api/session/refresh`,
      "POST",
      { refreshToken: this.refreshTokenValue },
      void 0,
      this.timeout
    );
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        if (this.tokenGeneration === genBefore) {
          this.accessToken = null;
          this.refreshTokenValue = null;
          this.accessTokenExpiresAt = 0;
        } else {
          this.log.info("[session] Stale 401/403 ignored \u2014 tokens already rotated by concurrent call.");
        }
        throw new Error("Refresh token expired or revoked. Must re-authenticate via challenge flow.");
      }
      throw new Error(`Token refresh failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    }
    const tokens = res.data;
    this.applyTokens(tokens);
    return tokens;
  }
  async logout() {
    if (!this.refreshTokenValue) return;
    try {
      await rawFetch(
        `${this.baseUrl}/api/session/logout`,
        "POST",
        { refreshToken: this.refreshTokenValue },
        void 0,
        this.timeout
      );
    } finally {
      this.destroy();
      this.accessToken = null;
      this.refreshTokenValue = null;
      this.accessTokenExpiresAt = 0;
      this.sessionId = null;
    }
  }
  async initialize() {
    if (this.refreshTokenValue) {
      try {
        this.log.info("[session] Refreshing existing session...");
        await this.refresh();
        this.log.info(`[session] Session refreshed. Tier: ${this.tier}, Scopes: ${this.scopes.join(", ")}`);
        return;
      } catch (err) {
        this.log.warn(`[session] Refresh failed: ${err.message}. Falling back to challenge flow.`);
      }
    }
    if (!this.apiKey) {
      throw new Error(
        "No apiKey configured. On this machine run: traderclaw setup --signup (or traderclaw signup) for a new account, or add an API key via traderclaw setup. The agent cannot create accounts or change credentials."
      );
    }
    this.log.info("[session] Starting challenge flow...");
    const challenge = await this.requestChallenge();
    let walletPubKey;
    let walletSig;
    if (challenge.walletProofRequired && challenge.challenge) {
      const walletPrivateKey = (await this.walletPrivateKeyProvider?.())?.trim();
      if (!walletPrivateKey) {
        throw new Error(
          `Wallet proof required but no walletPrivateKey configured. This account already has a wallet \u2014 set TRADERCLAW_WALLET_PRIVATE_KEY in the OpenClaw gateway process environment (e.g. systemd), not only in an SSH shell, then restart the gateway. The key is used only for local signing and is never sent to the orchestrator. Do not store private keys in openclaw.json. Troubleshooting: ${TRADERCLAW_SESSION_TROUBLESHOOTING}`
        );
      }
      walletPubKey = challenge.walletPublicKey || this.walletPublicKey || void 0;
      this.log.info("[session] Signing wallet challenge locally...");
      walletSig = await signChallengeAsync(challenge.challenge, walletPrivateKey);
    }
    const tokens = await this.startSession(challenge.challengeId, walletPubKey, walletSig);
    this.log.info(`[session] Session established. ID: ${this.sessionId}, Tier: ${this.tier}`);
    if (challenge.walletPublicKey) {
      this.walletPublicKey = challenge.walletPublicKey;
    }
  }
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 12e4) {
      return this.accessToken;
    }
    await this.unifiedRefresh();
    if (!this.accessToken) {
      throw new Error(
        `Session expired and could not be refreshed. Re-authentication required. Troubleshooting: ${TRADERCLAW_SESSION_TROUBLESHOOTING}`
      );
    }
    return this.accessToken;
  }
  async handleUnauthorized() {
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    await this.unifiedRefresh();
    if (!this.accessToken) {
      throw new Error(
        `Session expired and could not be refreshed. Re-authentication required. Troubleshooting: ${TRADERCLAW_SESSION_TROUBLESHOOTING}`
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
  async unifiedRefresh() {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.ensureRefreshed().finally(() => {
        this.refreshInFlight = null;
      });
    }
    await this.refreshInFlight;
  }
  isAuthenticated() {
    return !!this.accessToken;
  }
  getSessionInfo() {
    return {
      sessionId: this.sessionId,
      tier: this.tier,
      scopes: this.scopes,
      apiKey: this.apiKey
    };
  }
  getApiKey() {
    return this.apiKey;
  }
  getRefreshToken() {
    return this.refreshTokenValue;
  }
  getWalletPublicKey() {
    return this.walletPublicKey;
  }
  applyTokens(tokens) {
    this.tokenGeneration++;
    this.accessToken = tokens.accessToken;
    this.refreshTokenValue = tokens.refreshToken;
    this.accessTokenExpiresAt = Date.now() + tokens.accessTokenTtlSeconds * 1e3;
    this.accessTokenTtlMs = tokens.accessTokenTtlSeconds * 1e3;
    this.refreshTokenTtlMs = (tokens.refreshTokenTtlSeconds || 0) * 1e3;
    this.sessionId = tokens.session.id;
    this.tier = tokens.session.tier;
    this.scopes = tokens.session.scopes;
    if (this.onTokensRotated) {
      this.onTokensRotated({
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: this.accessTokenExpiresAt,
        walletPublicKey: this.walletPublicKey || void 0
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
  scheduleProactiveRefresh() {
    if (this.proactiveRefreshTimer) {
      clearInterval(this.proactiveRefreshTimer);
      this.proactiveRefreshTimer = null;
    }
    const MIN_INTERVAL_MS = 2 * 60 * 1e3;
    const MAX_INTERVAL_MS = 20 * 60 * 1e3;
    const DEFAULT_INTERVAL_MS = 10 * 60 * 1e3;
    let intervalMs;
    if (this.refreshTokenTtlMs > 0) {
      intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(this.refreshTokenTtlMs * 0.5, MAX_INTERVAL_MS));
    } else {
      intervalMs = DEFAULT_INTERVAL_MS;
    }
    if (this.accessTokenTtlMs > 0) {
      const accessBasedMs = Math.max(MIN_INTERVAL_MS, this.accessTokenTtlMs - 15e4);
      intervalMs = Math.min(intervalMs, accessBasedMs);
    }
    this.log.info(`[session] Proactive refresh scheduled every ${Math.round(intervalMs / 1e3)}s`);
    this.proactiveRefreshTimer = setInterval(async () => {
      if (this.proactiveRefreshRunning) return;
      this.proactiveRefreshRunning = true;
      try {
        this.log.info(`[session] Proactive token refresh (interval: ${Math.round(intervalMs / 1e3)}s)...`);
        await this.unifiedRefresh();
        this.log.info("[session] Proactive refresh succeeded \u2014 token chain extended.");
      } catch (err) {
        this.log.warn(`[session] Proactive refresh failed: ${err.message}. Will retry next interval or on-demand.`);
      } finally {
        this.proactiveRefreshRunning = false;
      }
    }, intervalMs);
    if (this.proactiveRefreshTimer && typeof this.proactiveRefreshTimer === "object" && "unref" in this.proactiveRefreshTimer) {
      this.proactiveRefreshTimer.unref();
    }
  }
  destroy() {
    if (this.proactiveRefreshTimer) {
      clearInterval(this.proactiveRefreshTimer);
      this.proactiveRefreshTimer = null;
    }
  }
  async ensureRefreshed() {
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
};

export {
  SessionManager
};
