// src/alpha-ws.ts
var RECONNECT_DELAYS = [1e3, 2e3, 4e3, 8e3, 16e3, 3e4];
var PING_INTERVAL_MS = 3e4;
var PONG_TIMEOUT_MS = 1e4;
var ALPHA_INGESTION_STALE_MS = 20 * 60 * 1e3;
var ALPHA_STALE_GRACE_AFTER_CONNECT_MS = 3 * 60 * 1e3;
var AlphaStreamManager = class {
  config;
  ws = null;
  subscribed = false;
  authenticated = false;
  reconnectAttempt = 0;
  reconnectTimer = null;
  intentionalClose = false;
  messageCount = 0;
  lastEventTs = 0;
  connectedAt = 0;
  tier = "";
  premiumAccess = false;
  currentAccessToken = "";
  constructor(config) {
    this.config = config;
  }
  /**
   * @param opts.force If true, drop the existing WebSocket (when connected) and subscribe again.
   * Use when the socket looks healthy but alpha_signal delivery may have stalled.
   */
  async subscribe(opts = {}) {
    const force = Boolean(opts.force);
    if (!force && this.subscribed && this.ws && this.ws.readyState === 1) {
      return { subscribed: true, premiumAccess: this.premiumAccess, tier: this.tier };
    }
    if (force && this.ws) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const oldWs = this.ws;
      this.intentionalClose = true;
      this.log("info", "Force subscribe: closing WebSocket for clean reconnect");
      await new Promise((resolve) => {
        if (oldWs.readyState === 3) {
          resolve();
          return;
        }
        const t = setTimeout(resolve, 5e3);
        oldWs.once("close", () => {
          clearTimeout(t);
          resolve();
        });
        try {
          if (oldWs.readyState === 1 || oldWs.readyState === 0) {
            oldWs.close();
          } else {
            clearTimeout(t);
            resolve();
          }
        } catch {
          clearTimeout(t);
          resolve();
        }
      });
      this.ws = null;
      this.subscribed = false;
      this.authenticated = false;
      this.intentionalClose = false;
    }
    this.intentionalClose = false;
    await this.connect();
    return new Promise((resolve, reject) => {
      const checkSubscribed = setInterval(() => {
        if (this.subscribed) {
          clearTimeout(timeout);
          clearInterval(checkSubscribed);
          resolve({ subscribed: true, premiumAccess: this.premiumAccess, tier: this.tier });
        }
      }, 100);
      const timeout = setTimeout(() => {
        clearInterval(checkSubscribed);
        reject(new Error("Alpha stream subscription timed out after 15 seconds"));
      }, 15e3);
    });
  }
  /**
   * True when the socket reports subscribed but no alpha_signal has been received for
   * {@link ALPHA_INGESTION_STALE_MS} (after {@link ALPHA_STALE_GRACE_AFTER_CONNECT_MS}).
   */
  isIngestionStale(now = Date.now()) {
    if (!this.isSubscribed()) return false;
    const uptime = now - this.connectedAt;
    if (uptime < ALPHA_STALE_GRACE_AFTER_CONNECT_MS) return false;
    const lastActivity = this.lastEventTs > 0 ? this.lastEventTs : this.connectedAt;
    return now - lastActivity >= ALPHA_INGESTION_STALE_MS;
  }
  /**
   * Re-send alpha_stream_subscribe on the existing connection (soft recovery).
   * @returns true if the message was sent
   */
  resendApplicationSubscribe() {
    if (!this.authenticated || !this.ws || this.ws.readyState !== 1) return false;
    this.sendAlphaSubscribe();
    return true;
  }
  async unsubscribe() {
    this.intentionalClose = true;
    this.subscribed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        if (this.ws.readyState === 1) {
          this.ws.send(JSON.stringify({ type: "alpha_stream_unsubscribe" }));
        }
        this.ws.close();
      } catch {
      }
      this.ws = null;
    }
    return { unsubscribed: true };
  }
  getAgentId() {
    return this.config.agentId;
  }
  setAgentId(agentId) {
    this.config.agentId = agentId;
  }
  setSubscriberType(subscriberType) {
    this.config.subscriberType = subscriberType;
  }
  isSubscribed() {
    return this.subscribed && this.ws !== null && this.ws.readyState === 1;
  }
  getStats() {
    return {
      subscribed: this.isSubscribed(),
      messageCount: this.messageCount,
      lastEventTs: this.lastEventTs,
      connectedAt: this.connectedAt,
      uptimeSeconds: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1e3) : 0
    };
  }
  sendAlphaSubscribe() {
    if (!this.ws || this.ws.readyState !== 1) return;
    const subscribeMsg = { type: "alpha_stream_subscribe" };
    if (this.config.agentId) {
      subscribeMsg.agentId = this.config.agentId;
    }
    if (this.config.subscriberType) {
      subscribeMsg.subscriberType = this.config.subscriberType;
    } else if (this.config.agentId) {
      subscribeMsg.subscriberType = "agent";
    }
    this.log("info", "Sending alpha_stream_subscribe");
    this.ws.send(JSON.stringify(subscribeMsg));
  }
  async connect() {
    const WebSocket = (await import("ws")).default;
    this.currentAccessToken = await this.config.getAccessToken();
    const url = `${this.config.wsUrl}?accessToken=${encodeURIComponent(this.currentAccessToken)}`;
    this.authenticated = false;
    this.log("info", `Connecting to alpha stream: ${this.config.wsUrl}`);
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 1e4 });
      } catch (err) {
        reject(err);
        return;
      }
      const connectTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== 1) {
          this.ws.close();
          reject(new Error("WebSocket connection timed out"));
        }
      }, 1e4);
      let pingInterval = null;
      let pongTimer = null;
      const clearKeepalive = () => {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        if (pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
      };
      this.ws.on("open", () => {
        clearTimeout(connectTimeout);
        this.connectedAt = Date.now();
        this.reconnectAttempt = 0;
        this.log("info", "WebSocket connected, waiting for server handshake...");
        pingInterval = setInterval(() => {
          if (!this.ws || this.ws.readyState !== 1) return;
          pongTimer = setTimeout(() => {
            this.log("warn", "Pong timeout \u2014 forcing reconnect");
            this.ws?.terminate();
          }, PONG_TIMEOUT_MS);
          try {
            this.ws.ping();
          } catch {
          }
        }, PING_INTERVAL_MS);
        resolve();
      });
      this.ws.on("pong", () => {
        if (pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
      });
      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch {
          this.log("warn", "Failed to parse WebSocket message");
        }
      });
      this.ws.on("close", () => {
        clearTimeout(connectTimeout);
        clearKeepalive();
        this.subscribed = false;
        this.authenticated = false;
        this.log("info", "WebSocket closed");
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      });
      this.ws.on("error", (err) => {
        clearTimeout(connectTimeout);
        this.log("error", `WebSocket error: ${err.message}`);
        if (this.ws && this.ws.readyState !== 1) {
          reject(err);
        }
      });
    });
  }
  handleMessage(msg) {
    switch (msg.type) {
      case "connected":
        if (!this.authenticated) {
          this.log("info", "Server handshake received, sending auth...");
          if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ type: "auth", accessToken: this.currentAccessToken }));
          }
        }
        break;
      case "authenticated":
        this.tier = msg.tier || "";
        if (!this.authenticated) {
          this.authenticated = true;
          this.log("info", `Authenticated: tier=${this.tier}`);
          this.sendAlphaSubscribe();
        }
        break;
      case "alpha_stream_subscribed":
        this.subscribed = true;
        this.tier = msg.tier || this.tier;
        this.premiumAccess = msg.premiumAccess || false;
        this.log("info", `Subscribed to alpha stream: tier=${this.tier}, premium=${this.premiumAccess}`);
        break;
      case "alpha_stream_unsubscribed":
        this.subscribed = false;
        this.log("info", "Unsubscribed from alpha stream");
        break;
      case "alpha_signal": {
        this.messageCount++;
        this.lastEventTs = Date.now();
        const data = msg.data;
        if (data) {
          const signal = {
            sourceName: data.sourceName || "",
            sourceType: data.sourceType || "telegram",
            externalRef: data.externalRef,
            isPremium: data.isPremium || false,
            tokenAddress: data.tokenAddress || "",
            tokenName: data.tokenName || "",
            tokenSymbol: data.tokenSymbol || "",
            chain: data.chain || "solana",
            marketCap: data.marketCap,
            price: data.price,
            kind: data.kind || "ca_drop",
            signalStage: data.signalStage || "early",
            summary: data.summary || "",
            confidence: data.confidence || "low",
            calledAgainCount: data.calledAgainCount ?? 0,
            systemScore: data.systemScore ?? 0,
            ts: msg.ts || Date.now(),
            eventId: data.eventId
          };
          this.config.buffer.push(signal);
        }
        break;
      }
      case "error": {
        const code = msg.code;
        this.log("error", `WebSocket error: ${code} \u2014 ${msg.message || ""}`);
        if (code === "WS_AUTH_REQUIRED" || code === "WS_AUTH_INVALID" || code === "WS_SESSION_INVALID" || code === "ACCESS_TOKEN_FORMAT_INVALID" || code === "ACCESS_TOKEN_EXPIRED") {
          this.authenticated = false;
          this.log("warn", "Auth error \u2014 closing and will reconnect with fresh token");
          if (this.ws) this.ws.close();
        }
        break;
      }
    }
  }
  scheduleReconnect() {
    if (this.intentionalClose) return;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt++;
    this.log("info", `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        this.log("error", `Reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
        this.scheduleReconnect();
      }
    }, delay);
  }
  log(level, msg) {
    if (this.config.logger) {
      this.config.logger[level](`[alpha-stream] ${msg}`);
    }
  }
};

export {
  ALPHA_INGESTION_STALE_MS,
  ALPHA_STALE_GRACE_AFTER_CONNECT_MS,
  AlphaStreamManager
};
