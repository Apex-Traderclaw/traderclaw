import { AlphaBuffer, type AlphaSignal } from "./alpha-buffer.js";

interface AlphaWSConfig {
  wsUrl: string;
  getAccessToken: () => Promise<string>;
  buffer: AlphaBuffer;
  agentId?: string;
  subscriberType?: string;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

interface WSMessage {
  type: string;
  [key: string]: unknown;
}

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

/** No alpha_signal for this long after grace → treat ingestion as stale (watchdog may recover). */
export const ALPHA_INGESTION_STALE_MS = 20 * 60 * 1000;
/** Ignore staleness until the connection has been up this long (bootstrap + quiet startup). */
export const ALPHA_STALE_GRACE_AFTER_CONNECT_MS = 3 * 60 * 1000;

export class AlphaStreamManager {
  private config: AlphaWSConfig;
  private ws: import("ws") | null = null;
  private subscribed = false;
  private authenticated = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private messageCount = 0;
  private lastEventTs = 0;
  private connectedAt = 0;
  private tier = "";
  private premiumAccess = false;
  private currentAccessToken = "";

  constructor(config: AlphaWSConfig) {
    this.config = config;
  }

  /**
   * @param opts.force If true, drop the existing WebSocket (when connected) and subscribe again.
   * Use when the socket looks healthy but alpha_signal delivery may have stalled.
   */
  async subscribe(opts: { force?: boolean } = {}): Promise<{ subscribed: boolean; premiumAccess: boolean; tier: string }> {
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
      await new Promise<void>((resolve) => {
        if (oldWs.readyState === 3) {
          resolve();
          return;
        }
        const t = setTimeout(resolve, 5000);
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
      }, 15000);
    });
  }

  /**
   * True when the socket reports subscribed but no alpha_signal has been received for
   * {@link ALPHA_INGESTION_STALE_MS} (after {@link ALPHA_STALE_GRACE_AFTER_CONNECT_MS}).
   */
  isIngestionStale(now: number = Date.now()): boolean {
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
  resendApplicationSubscribe(): boolean {
    if (!this.authenticated || !this.ws || this.ws.readyState !== 1) return false;
    this.sendAlphaSubscribe();
    return true;
  }

  async unsubscribe(): Promise<{ unsubscribed: boolean }> {
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
        // ignore close errors
      }
      this.ws = null;
    }

    return { unsubscribed: true };
  }

  getAgentId(): string | undefined {
    return this.config.agentId;
  }

  setAgentId(agentId: string): void {
    this.config.agentId = agentId;
  }

  setSubscriberType(subscriberType: string): void {
    this.config.subscriberType = subscriberType;
  }

  isSubscribed(): boolean {
    return this.subscribed && this.ws !== null && this.ws.readyState === 1;
  }

  getStats(): { subscribed: boolean; messageCount: number; lastEventTs: number; connectedAt: number; uptimeSeconds: number } {
    return {
      subscribed: this.isSubscribed(),
      messageCount: this.messageCount,
      lastEventTs: this.lastEventTs,
      connectedAt: this.connectedAt,
      uptimeSeconds: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0,
    };
  }

  private sendAlphaSubscribe(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const subscribeMsg: Record<string, unknown> = { type: "alpha_stream_subscribe" };
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

  private async connect(): Promise<void> {
    const WebSocket = (await import("ws")).default;
    this.currentAccessToken = await this.config.getAccessToken();
    const url = `${this.config.wsUrl}?accessToken=${encodeURIComponent(this.currentAccessToken)}`;

    this.authenticated = false;
    this.log("info", `Connecting to alpha stream: ${this.config.wsUrl}`);

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }

      const connectTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== 1) {
          this.ws.close();
          reject(new Error("WebSocket connection timed out"));
        }
      }, 10000);

      let pingInterval: ReturnType<typeof setInterval> | null = null;
      let pongTimer: ReturnType<typeof setTimeout> | null = null;

      const clearKeepalive = () => {
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
      };

      this.ws.on("open", () => {
        clearTimeout(connectTimeout);
        this.connectedAt = Date.now();
        this.reconnectAttempt = 0;
        this.log("info", "WebSocket connected, waiting for server handshake...");

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

      this.ws.on("pong", () => {
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
      });

      this.ws.on("message", (data: Buffer | string) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString());
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

      this.ws.on("error", (err: Error) => {
        clearTimeout(connectTimeout);
        this.log("error", `WebSocket error: ${err.message}`);
        if (this.ws && this.ws.readyState !== 1) {
          reject(err);
        }
      });
    });
  }

  private handleMessage(msg: WSMessage): void {
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
        this.tier = (msg.tier as string) || "";
        if (!this.authenticated) {
          this.authenticated = true;
          this.log("info", `Authenticated: tier=${this.tier}`);
          this.sendAlphaSubscribe();
        }
        break;

      case "alpha_stream_subscribed":
        this.subscribed = true;
        this.tier = (msg.tier as string) || this.tier;
        this.premiumAccess = (msg.premiumAccess as boolean) || false;
        this.log("info", `Subscribed to alpha stream: tier=${this.tier}, premium=${this.premiumAccess}`);
        break;

      case "alpha_stream_unsubscribed":
        this.subscribed = false;
        this.log("info", "Unsubscribed from alpha stream");
        break;

      case "alpha_signal": {
        this.messageCount++;
        this.lastEventTs = Date.now();
        const data = msg.data as Record<string, unknown>;
        if (data) {
          const signal: Omit<AlphaSignal, "_seen" | "_ingestedAt"> = {
            sourceName: (data.sourceName as string) || "",
            sourceType: (data.sourceType as "telegram" | "discord") || "telegram",
            externalRef: data.externalRef as string | undefined,
            isPremium: (data.isPremium as boolean) || false,
            tokenAddress: (data.tokenAddress as string) || "",
            tokenName: (data.tokenName as string) || "",
            tokenSymbol: (data.tokenSymbol as string) || "",
            chain: (data.chain as string) || "solana",
            marketCap: data.marketCap as number | undefined,
            price: data.price as number | undefined,
            kind: (data.kind as AlphaSignal["kind"]) || "ca_drop",
            signalStage: (data.signalStage as AlphaSignal["signalStage"]) || "early",
            summary: (data.summary as string) || "",
            confidence: (data.confidence as AlphaSignal["confidence"]) || "low",
            calledAgainCount: (data.calledAgainCount as number) ?? 0,
            systemScore: (data.systemScore as number) ?? 0,
            ts: (msg.ts as number) || Date.now(),
            eventId: data.eventId as string | undefined,
          };
          this.config.buffer.push(signal);
        }
        break;
      }

      case "error": {
        const code = msg.code as string;
        this.log("error", `WebSocket error: ${code} — ${msg.message || ""}`);
        if (
          code === "WS_AUTH_REQUIRED" ||
          code === "WS_AUTH_INVALID" ||
          code === "WS_SESSION_INVALID" ||
          code === "ACCESS_TOKEN_FORMAT_INVALID" ||
          code === "ACCESS_TOKEN_EXPIRED"
        ) {
          this.authenticated = false;
          this.log("warn", "Auth error — closing and will reconnect with fresh token");
          if (this.ws) this.ws.close();
        }
        break;
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
    if (this.config.logger) {
      this.config.logger[level](`[alpha-stream] ${msg}`);
    }
  }
}
