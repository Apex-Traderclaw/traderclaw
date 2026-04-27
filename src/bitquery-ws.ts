interface BitqueryWsConfig {
  wsUrl: string;
  walletId: string;
  getAccessToken: () => Promise<string>;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

interface ActiveSubscription {
  subscriptionId: string;
  templateKey: string;
  variables: Record<string, unknown>;
  agentId?: string;
  subscriberType?: string;
}

interface PendingSubscribe {
  resolve: (v: { subscriptionId: string; streamKey: string }) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  templateKey: string;
  variables: Record<string, unknown>;
  agentId?: string;
  subscriberType?: string;
}

interface PendingUnsubscribe {
  resolve: (v: { unsubscribed: boolean }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

/**
 * Manages a persistent WebSocket connection to the orchestrator for
 * bitquery_subscribe / bitquery_unsubscribe messages. The server only
 * exposes these as WS message types, not HTTP endpoints.
 *
 * Subscriptions are kept alive as long as this connection is open.
 * On reconnect, all active subscriptions are automatically re-registered.
 */
export class BitqueryStreamManager {
  private config: BitqueryWsConfig;
  private ws: import("ws") | null = null;
  private authenticated = false;
  private connecting = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private currentAccessToken = "";

  // FIFO queue — server doesn't echo a requestId, so we match by arrival order
  private pendingSubscribeQueue: PendingSubscribe[] = [];

  // keyed by subscriptionId
  private pendingUnsubscribes = new Map<string, PendingUnsubscribe>();

  // tracks active subscriptions for auto-resubscribe on reconnect
  private activeSubscriptions = new Map<string, ActiveSubscription>();

  constructor(config: BitqueryWsConfig) {
    this.config = config;
  }

  async subscribe(params: {
    templateKey: string;
    variables?: Record<string, unknown>;
    agentId?: string;
    subscriberType?: string;
  }): Promise<{ subscriptionId: string; streamKey: string }> {
    await this.ensureConnected();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.pendingSubscribeQueue.findIndex((p) => p.resolve === resolve);
        if (idx !== -1) this.pendingSubscribeQueue.splice(idx, 1);
        reject(new Error("bitquery_subscribe timed out after 15 seconds"));
      }, 15000);

      this.pendingSubscribeQueue.push({
        resolve,
        reject,
        timeout,
        templateKey: params.templateKey,
        variables: params.variables || {},
        agentId: params.agentId,
        subscriberType: params.subscriberType,
      });

      const msg: Record<string, unknown> = {
        type: "bitquery_subscribe",
        templateKey: params.templateKey,
        variables: params.variables || {},
        walletId: this.config.walletId,
      };
      if (params.agentId) {
        msg.agentId = params.agentId;
        msg.subscriberType = params.subscriberType || "agent";
      } else if (params.subscriberType) {
        msg.subscriberType = params.subscriberType;
      }

      try {
        this.ws!.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timeout);
        const idx = this.pendingSubscribeQueue.findIndex((p) => p.resolve === resolve);
        if (idx !== -1) this.pendingSubscribeQueue.splice(idx, 1);
        reject(new Error(`Failed to send subscribe: ${err}`));
      }
    });
  }

  async unsubscribe(subscriptionId: string): Promise<{ unsubscribed: boolean }> {
    this.activeSubscriptions.delete(subscriptionId);

    if (!this.ws || this.ws.readyState !== 1) {
      return { unsubscribed: true };
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingUnsubscribes.delete(subscriptionId);
        resolve({ unsubscribed: true });
      }, 10000);

      this.pendingUnsubscribes.set(subscriptionId, { resolve, timeout });

      try {
        this.ws!.send(JSON.stringify({ type: "bitquery_unsubscribe", subscriptionId }));
      } catch {
        clearTimeout(timeout);
        this.pendingUnsubscribes.delete(subscriptionId);
        resolve({ unsubscribed: true });
      }
    });
  }

  /** Close the WS if no active subscriptions remain. */
  disconnectIfIdle(): void {
    if (this.activeSubscriptions.size === 0) {
      this.close();
    }
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
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
  private forceReconnect(reason: string): void {
    this.log("warn", `Force reconnect: ${reason}`);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
    this.authenticated = false;
    if (this.activeSubscriptions.size > 0) {
      this.scheduleReconnect();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === 1 && this.authenticated) return;

    if (this.connecting) {
      // Wait until authenticated
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for connection")), 20000);
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
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Authentication timed out")), 15000);
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

  private async connect(): Promise<void> {
    const WebSocket = (await import("ws")).default;
    this.currentAccessToken = await this.config.getAccessToken();
    const url = `${this.config.wsUrl}?accessToken=${encodeURIComponent(this.currentAccessToken)}`;

    this.authenticated = false;
    this.log("info", `Connecting to ${this.config.wsUrl}`);

    return new Promise((resolve, reject) => {
      let ws: import("ws");
      try {
        ws = new WebSocket(url) as unknown as import("ws");
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
      }, 10000);

      let pingInterval: ReturnType<typeof setInterval> | null = null;
      let pongTimer: ReturnType<typeof setTimeout> | null = null;

      const clearKeepalive = () => {
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
      };

      ws.on("open", () => {
        clearTimeout(connectTimeout);
        this.reconnectAttempt = 0;
        this.log("info", "Connected");

        pingInterval = setInterval(() => {
          if (!this.ws || this.ws.readyState !== 1) return;
          pongTimer = setTimeout(() => {
            this.log("warn", "Pong timeout — forcing reconnect");
            this.ws?.terminate();
          }, PONG_TIMEOUT_MS);
          try { this.ws.ping(); } catch { /* ignore if ws already closing */ }
        }, PING_INTERVAL_MS);

        resolve();
      });

      ws.on("pong", () => {
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
      });

      ws.on("message", (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
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

      ws.on("error", (err: Error) => {
        clearTimeout(connectTimeout);
        this.log("error", `WS error: ${err.message}`);
        if (ws.readyState !== 1) {
          reject(err);
        }
      });
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
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
        const subscriptionId = msg.subscriptionId as string;
        const streamKey = msg.streamKey as string;
        const pending = this.pendingSubscribeQueue.shift();
        if (pending) {
          clearTimeout(pending.timeout);
          this.activeSubscriptions.set(subscriptionId, {
            subscriptionId,
            templateKey: pending.templateKey,
            variables: pending.variables,
            agentId: pending.agentId,
            subscriberType: pending.subscriberType,
          });
          pending.resolve({ subscriptionId, streamKey });
        }
        break;
      }

      case "bitquery_unsubscribed": {
        const subscriptionId = msg.subscriptionId as string;
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
        const code = msg.code as string;
        this.log("error", `${code}: ${msg.message || ""}`);
        // Fail the first pending subscribe if the error is related to subscription
        if (
          ["WS_SUBSCRIBE_VALIDATION_ERROR", "BITQUERY_SUBSCRIPTION_TEMPLATE_NOT_FOUND",
           "WS_SUBSCRIPTION_LIMIT_REACHED", "WS_BRIDGE_UNAVAILABLE"].includes(code)
        ) {
          const pending = this.pendingSubscribeQueue.shift();
          if (pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(`${code}: ${msg.message || ""}`));
          }
        }
        // On auth errors, force reconnect with a fresh token without marking
        // the close as intentional (which would suppress auto-reconnect).
        if (["WS_AUTH_REQUIRED", "WS_AUTH_INVALID", "ACCESS_TOKEN_EXPIRED"].includes(code)) {
          this.forceReconnect(code);
        }
        break;
      }
    }
  }

  private drainPendingOnClose(): void {
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

  private async resubscribeAll(): Promise<void> {
    if (this.activeSubscriptions.size === 0) return;
    const subs = [...this.activeSubscriptions.values()];
    // Remove each stale entry individually before attempting to re-subscribe
    // so the map doesn't hold dead IDs. On failure the original entry is
    // restored so the next reconnect can retry it.
    this.log("info", `Re-subscribing ${subs.length} subscription(s) after reconnect`);
    for (const sub of subs) {
      this.activeSubscriptions.delete(sub.subscriptionId);
      try {
        const result = await this.subscribe({
          templateKey: sub.templateKey,
          variables: sub.variables,
          agentId: sub.agentId,
          subscriberType: sub.subscriberType,
        });
        this.log("info", `Re-subscribed ${sub.templateKey} → new id: ${result.subscriptionId}`);
      } catch (err) {
        this.log("error", `Re-subscribe failed for ${sub.templateKey}: ${err}`);
        // Restore the original entry so the next reconnect cycle can retry it.
        this.activeSubscriptions.set(sub.subscriptionId, sub);
      }
    }
  }

  private scheduleReconnect(): void {
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

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.config.logger?.[level](`[bitquery-ws] ${msg}`);
  }
}
