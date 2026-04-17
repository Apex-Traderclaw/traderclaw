import { useEffect, useState } from "react";
import { queryClient, getAccessToken } from "@/lib/queryClient";
import { emitDashboardLogBatch } from "@/lib/dashboard-log-bus";
import { dashboardSocketFeatureEnabled } from "@/lib/feature-flags";

type WSChannel =
  | "positions"
  | "trades"
  | "risk-events"
  | "entitlements"
  | "system-status"
  | "strategy"
  | "dashboard-logs";

interface WSMessage {
  channel?: WSChannel;
  /** Server sends Bitquery-style `{ type, channel, data, ts }` */
  type?: string;
  event?: string;
  data?: unknown;
  timestamp?: string;
  ts?: number;
}

let sharedWs: WebSocket | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectedState = false;
const listeners = new Set<(connected: boolean) => void>();

function notifyListeners(connected: boolean) {
  connectedState = connected;
  listeners.forEach((fn) => {
    fn(connected);
  });
}

function mergePositionFromStream(walletId: string, position: { id: string; currentPrice?: number; unrealizedPnl?: number }) {
  const suffix = `?walletId=${walletId}&status=open`;
  queryClient.setQueryData<unknown>(["/api/wallet/positions", suffix], (old) => {
    if (!Array.isArray(old)) return old;
    return old.map((p: { id: string }) =>
      p.id === position.id ? { ...p, ...position } : p,
    );
  });
}

function handleMessage(event: MessageEvent) {
  try {
    const msg: WSMessage = JSON.parse(event.data);
    if (
      msg.channel === "dashboard-logs" &&
      msg.type === "dashboard-log-batch" &&
      msg.data &&
      typeof msg.data === "object"
    ) {
      const payload = msg.data as { lines?: unknown; replay?: boolean };
      const lines = Array.isArray(payload.lines) ? payload.lines.map((l) => String(l)) : [];
      emitDashboardLogBatch(lines, Boolean(payload.replay));
      return;
    }
    if (msg.channel === "positions" && msg.type === "position-price-tick" && msg.data && typeof msg.data === "object") {
      const payload = msg.data as { walletId?: string; position?: { id: string } };
      if (payload.walletId && payload.position?.id) {
        mergePositionFromStream(payload.walletId, payload.position);
        return;
      }
    }
    switch (msg.channel as string) {
      case "dashboard-logs":
        break;
      case "positions":
        queryClient.invalidateQueries({ queryKey: ["/api/wallet/positions"] });
        queryClient.invalidateQueries({ queryKey: ["/api/capital/status"] });
        break;
      case "trades":
        queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
        queryClient.invalidateQueries({ queryKey: ["/api/capital/status"] });
        break;
      case "risk-events":
        queryClient.invalidateQueries({ queryKey: ["/api/risk-denials"] });
        break;
      case "entitlements":
        queryClient.invalidateQueries({ queryKey: ["/api/entitlements/current"] });
        queryClient.invalidateQueries({ queryKey: ["/api/capital/status"] });
        break;
      case "system-status":
        queryClient.invalidateQueries({ queryKey: ["/api/killswitch/status"] });
        queryClient.invalidateQueries({ queryKey: ["/api/system/status"] });
        break;
      case "strategy":
        queryClient.invalidateQueries({ queryKey: ["/api/strategy/state"] });
        break;
    }
  } catch {}
}

function getSubscribeChannels(): string[] {
  const base = ["positions", "trades", "risk-events", "entitlements", "system-status", "strategy"];
  if (dashboardSocketFeatureEnabled()) {
    return [...base, "dashboard-logs"];
  }
  return base;
}

function connectShared() {
  if (sharedWs?.readyState === WebSocket.OPEN || sharedWs?.readyState === WebSocket.CONNECTING) return;

  // When running behind a platform proxy (e.g. Vercel previews), `/ws` may not be reachable.
  // Prefer an explicit websocket destination configured via Vercel env var.
  const wsUrl = import.meta.env.VITE_OPENCLAW_WS_URL as string | undefined;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const trimmedWsUrl = wsUrl?.trim();
  const resolvedWsUrl = trimmedWsUrl ? trimmedWsUrl : `${protocol}//${window.location.host}/ws`;

  const url = new URL(resolvedWsUrl);
  const token = getAccessToken();
  if (token) {
    url.searchParams.set("accessToken", token);
  }

  const ws = new WebSocket(url.toString());

  ws.onopen = () => {
    notifyListeners(true);
    try {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          channels: getSubscribeChannels(),
        }),
      );
    } catch {
      // no-op: socket may have already transitioned state
    }
  };
  ws.onmessage = handleMessage;
  ws.onclose = () => {
    notifyListeners(false);
    sharedWs = null;
    if (refCount > 0) {
      reconnectTimer = setTimeout(connectShared, 3000);
    }
  };
  ws.onerror = () => ws.close();

  sharedWs = ws;
}

function addRef() {
  refCount++;
  if (refCount === 1) connectShared();
}

function removeRef() {
  refCount--;
  if (refCount <= 0) {
    refCount = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    sharedWs?.close();
    sharedWs = null;
  }
}

export function useWebSocket() {
  const [connected, setConnected] = useState(connectedState);

  useEffect(() => {
    listeners.add(setConnected);
    addRef();
    return () => {
      listeners.delete(setConnected);
      removeRef();
    };
  }, []);

  return { connected };
}
