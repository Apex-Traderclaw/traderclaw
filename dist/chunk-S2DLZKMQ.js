// src/bitquery-ws.ts
var RECONNECT_DELAYS = [1e3, 2e3, 4e3, 8e3, 16e3, 3e4];
var PING_INTERVAL_MS = 3e4;
var PONG_TIMEOUT_MS = 1e4;
var BitqueryStreamManager = class {
  config;
  ws = null;
  authenticated = false;
  connecting = false;
  reconnectAttempt = 0;
  reconnectTimer = null;
  intentionalClose = false;
  currentAccessToken = "";
  // FIFO queue — server doesn't echo a requestId, so we match by arrival order
  pendingSubscribeQueue = [];
  // keyed by subscriptionId
  pendingUnsubscribes = /* @__PURE__ */ new Map();
  // tracks active subscriptions for auto-resubscribe on reconnect
  activeSubscriptions = /* @__PURE__ */ new Map();
  constructor(config) {
    this.config = config;
  }
  async subscribe(params) {
    await this.ensureConnected();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.pendingSubscribeQueue.findIndex((p) => p.resolve === resolve);
        if (idx !== -1) this.pendingSubscribeQueue.splice(idx, 1);
        reject(new Error("bitquery_subscribe timed out after 15 seconds"));
      }, 15e3);
      this.pendingSubscribeQueue.push({
        resolve,
        reject,
        timeout,
        templateKey: params.templateKey,
        variables: params.variables || {},
        agentId: params.agentId,
        subscriberType: params.subscriberType
      });
      const msg = {
        type: "bitquery_subscribe",
        templateKey: params.templateKey,
        variables: params.variables || {},
        walletId: this.config.walletId
      };
      if (params.agentId) {
        msg.agentId = params.agentId;
        msg.subscriberType = params.subscriberType || "agent";
      } else if (params.subscriberType) {
        msg.subscriberType = params.subscriberType;
      }
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timeout);
        const idx = this.pendingSubscribeQueue.findIndex((p) => p.resolve === resolve);
        if (idx !== -1) this.pendingSubscribeQueue.splice(idx, 1);
        reject(new Error(`Failed to send subscribe: ${err}`));
      }
    });
  }
  async unsubscribe(subscriptionId) {
    this.activeSubscriptions.delete(subscriptionId);
    if (!this.ws || this.ws.readyState !== 1) {
      return { unsubscribed: true };
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingUnsubscribes.delete(subscriptionId);
        resolve({ unsubscribed: true });
      }, 1e4);
      this.pendingUnsubscribes.set(subscriptionId, { resolve, timeout });
      try {
        this.ws.send(JSON.stringify({ type: "bitquery_unsubscribe", subscriptionId }));
      } catch {
        clearTimeout(timeout);
        this.pendingUnsubscribes.delete(subscriptionId);
        resolve({ unsubscribed: true });
      }
    });
  }
  /** Close the WS if no active subscriptions remain. */
  disconnectIfIdle() {
    if (this.activeSubscriptions.size === 0) {
      this.close();
    }
  }
  close() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
      }
      this.ws = null;
    }
    this.authenticated = false;
  }
  /**
   * Close the socket and schedule a reconnect without marking the close as
   * intentional. Used for auth errors where we want to reconnect with a fresh
   * token rather than leaving the socket permanently dead.
   */
  forceReconnect(reason) {
    this.log("warn", `Force reconnect: ${reason}`);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
    }
    this.ws = null;
    this.authenticated = false;
    if (this.activeSubscriptions.size > 0) {
      this.scheduleReconnect();
    }
  }
  async ensureConnected() {
    if (this.ws && this.ws.readyState === 1 && this.authenticated) return;
    if (this.connecting) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for connection")), 2e4);
        const check = setInterval(() => {
          if (this.authenticated) {
            clearTimeout(timeout);
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
      return;
    }
    this.intentionalClose = false;
    this.connecting = true;
    try {
      await this.connect();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Authentication timed out")), 15e3);
        const check = setInterval(() => {
          if (this.authenticated) {
            clearTimeout(timeout);
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
    } finally {
      this.connecting = false;
    }
  }
  async connect() {
    const WebSocket = (await import("ws")).default;
    this.currentAccessToken = await this.config.getAccessToken();
    const url = `${this.config.wsUrl}?accessToken=${encodeURIComponent(this.currentAccessToken)}`;
    this.authenticated = false;
    this.log("info", `Connecting to ${this.config.wsUrl}`);
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url);
        this.ws = ws;
      } catch (err) {
        reject(err);
        return;
      }
      const connectTimeout = setTimeout(() => {
        if (ws.readyState !== 1) {
          ws.close();
          reject(new Error("WS connection timed out"));
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
      ws.on("open", () => {
        clearTimeout(connectTimeout);
        this.reconnectAttempt = 0;
        this.log("info", "Connected");
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
      ws.on("pong", () => {
        if (pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
      });
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch {
          this.log("warn", "Failed to parse message");
        }
      });
      ws.on("close", () => {
        clearTimeout(connectTimeout);
        clearKeepalive();
        this.authenticated = false;
        this.log("info", "WS closed");
        this.drainPendingOnClose();
        if (!this.intentionalClose && this.activeSubscriptions.size > 0) {
          this.scheduleReconnect();
        }
      });
      ws.on("error", (err) => {
        clearTimeout(connectTimeout);
        this.log("error", `WS error: ${err.message}`);
        if (ws.readyState !== 1) {
          reject(err);
        }
      });
    });
  }
  handleMessage(msg) {
    switch (msg.type) {
      case "connected":
        this.log("info", "Handshake received, authenticating...");
        if (this.ws && this.ws.readyState === 1) {
          this.ws.send(JSON.stringify({ type: "auth", accessToken: this.currentAccessToken }));
        }
        break;
      case "authenticated":
        this.authenticated = true;
        this.log("info", "Authenticated");
        void this.resubscribeAll();
        break;
      case "bitquery_subscribed": {
        const subscriptionId = msg.subscriptionId;
        const streamKey = msg.streamKey;
        const pending = this.pendingSubscribeQueue.shift();
        if (pending) {
          clearTimeout(pending.timeout);
          this.activeSubscriptions.set(subscriptionId, {
            subscriptionId,
            templateKey: pending.templateKey,
            variables: pending.variables,
            agentId: pending.agentId,
            subscriberType: pending.subscriberType
          });
          pending.resolve({ subscriptionId, streamKey });
        }
        break;
      }
      case "bitquery_unsubscribed": {
        const subscriptionId = msg.subscriptionId;
        this.activeSubscriptions.delete(subscriptionId);
        const pending = this.pendingUnsubscribes.get(subscriptionId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingUnsubscribes.delete(subscriptionId);
          pending.resolve({ unsubscribed: true });
        }
        this.disconnectIfIdle();
        break;
      }
      case "error": {
        const code = msg.code;
        this.log("error", `${code}: ${msg.message || ""}`);
        if ([
          "WS_SUBSCRIBE_VALIDATION_ERROR",
          "BITQUERY_SUBSCRIPTION_TEMPLATE_NOT_FOUND",
          "WS_SUBSCRIPTION_LIMIT_REACHED",
          "WS_BRIDGE_UNAVAILABLE"
        ].includes(code)) {
          const pending = this.pendingSubscribeQueue.shift();
          if (pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(`${code}: ${msg.message || ""}`));
          }
        }
        if (["WS_AUTH_REQUIRED", "WS_AUTH_INVALID", "ACCESS_TOKEN_EXPIRED"].includes(code)) {
          this.forceReconnect(code);
        }
        break;
      }
    }
  }
  drainPendingOnClose() {
    for (const pending of this.pendingSubscribeQueue) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("WebSocket closed before subscription was confirmed"));
    }
    this.pendingSubscribeQueue = [];
    for (const [, pending] of this.pendingUnsubscribes) {
      clearTimeout(pending.timeout);
      pending.resolve({ unsubscribed: true });
    }
    this.pendingUnsubscribes.clear();
  }
  async resubscribeAll() {
    if (this.activeSubscriptions.size === 0) return;
    const subs = [...this.activeSubscriptions.values()];
    this.log("info", `Re-subscribing ${subs.length} subscription(s) after reconnect`);
    for (const sub of subs) {
      this.activeSubscriptions.delete(sub.subscriptionId);
      try {
        const result = await this.subscribe({
          templateKey: sub.templateKey,
          variables: sub.variables,
          agentId: sub.agentId,
          subscriberType: sub.subscriberType
        });
        this.log("info", `Re-subscribed ${sub.templateKey} \u2192 new id: ${result.subscriptionId}`);
      } catch (err) {
        this.log("error", `Re-subscribe failed for ${sub.templateKey}: ${err}`);
        this.activeSubscriptions.set(sub.subscriptionId, sub);
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
    this.config.logger?.[level](`[bitquery-ws] ${msg}`);
  }
};

export {
  BitqueryStreamManager
};
